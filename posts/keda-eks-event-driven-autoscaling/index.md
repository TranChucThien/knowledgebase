---
title: "KEDA on EKS: event-driven autoscaling with SQS and IRSA"
date: 2026-10-19
tags: ["kubernetes", "eks", "keda", "autoscaling", "aws"]
summary: "How KEDA scales a worker on SQS queue depth: ScaledObject, the HPA it owns, scale to zero, the replica math, and giving the operator AWS credentials safely."
draft: false
---

The HPA scales on CPU and memory. Queue workers need something else: scale on
**how much work is waiting**, and go to zero when there is none. That is what
KEDA does. The example everywhere: a Deployment `worker` in namespace `orders`
that reads an SQS queue `orders-q` in `ap-southeast-1`. Account numbers like
`111122223333` are placeholders.

## TL;DR

- **KEDA** (Kubernetes Event-Driven Autoscaling) scales a workload on **external
  events**: queue length, Kafka lag, a Prometheus query, cron, CloudWatch… not
  only CPU/memory.
- You write a **ScaledObject** (target + triggers). KEDA **creates and owns an
  HPA** (`keda-hpa-<name>`) and feeds it an **external metric**. KEDA does not
  replace the HPA; it drives it.
- **0 ↔ 1** is done by the **KEDA operator** itself (activation). **1 ↔ N** is
  done by the **HPA** using the metric. That is how KEDA scales to zero, which a
  plain HPA cannot.
- To read AWS metrics the **keda-operator** needs AWS credentials: use a
  `TriggerAuthentication` with `podIdentity.provider: aws` plus IRSA or EKS Pod
  Identity. Never static keys in production.
- SQS math: replicas ≈ `ceil(messages / queueLength)`, capped by
  `maxReplicaCount`. In-flight messages count by default (`scaleOnInFlight: true`).
- Current release when written: **v2.21**. Read the release notes before
  upgrades: v2.20 moved events to `events.k8s.io` (RBAC), v2.21 enforces
  ServiceAccount token audiences.

## Scaling lifecycle

Who changes `replicas`, over time:

1. `worker` is idle at **0 replicas**. A producer sends 100 messages to `orders-q`.
2. Every `pollingInterval` (30 s) the **keda-operator** calls `GetQueueAttributes`.
3. Messages > `activationQueueLength` → the operator sets replicas **0 → 1**.
4. The **HPA** `keda-hpa-worker` reads the external metric through the
   metrics API server: `ceil(100 / 5) = 20`, capped at `maxReplicaCount` 10.
5. Workers consume and delete messages. The queue shrinks → the HPA scales down
   to 1 (with its stabilization window).
6. The queue stays empty for `cooldownPeriod` (300 s) → the operator sets **1 → 0**.

## 1. The pieces

| Piece | What it is | Who creates it |
| --- | --- | --- |
| keda-operator | Controller in ns `keda`. Watches ScaledObjects/ScaledJobs, runs the **scalers** (talks to SQS, Kafka…), does 0 ↔ 1, creates the HPA | Platform team, once per cluster (Helm `kedacore/keda`) |
| keda-operator-metrics-apiserver | Serves the **External Metrics API** (`external.metrics.k8s.io`). The HPA asks it; it asks the operator | Same Helm chart |
| Admission webhooks | Validate ScaledObjects (e.g. reject two ScaledObjects on one Deployment, or a ScaledObject plus your own HPA) | Same Helm chart |
| ScaledObject | CRD: target (`scaleTargetRef`), min/max replicas, triggers, polling and cooldown | You (usually in the app's Helm chart) |
| ScaledJob | CRD: instead of scaling a Deployment, creates **Jobs** per batch of events. Good for long, run-to-completion tasks | You |
| TriggerAuthentication / ClusterTriggerAuthentication | How a scaler authenticates: secret, env var, or `podIdentity` (aws, azure-workload, gcp). The cluster version is shared across namespaces | You or the platform team |
| HPA `keda-hpa-<name>` | Normal HPA with an `External` metric. Owned by KEDA: don't edit it, edit the ScaledObject | KEDA |
| IAM role | Permissions for the scaler to read the metric source, e.g. `sqs:GetQueueAttributes` on `orders-q` | You / Terraform, linked by IRSA or Pod Identity |

## 2. What you write

ScaledObject + TriggerAuthentication for SQS, using the keda-operator's own IAM role:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-podidentity
  namespace: orders
spec:
  podIdentity:
    provider: aws              # IRSA or EKS Pod Identity on the keda-operator SA
    # identityOwner: workload  # use the role of the worker's own SA instead
    # roleArn: arn:aws:iam::111122223333:role/orders-keda-reader   # operator assumes this role
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  namespace: orders
spec:
  scaleTargetRef:
    name: worker               # Deployment (default kind)
  minReplicaCount: 0           # 0 = scale to zero
  maxReplicaCount: 10
  pollingInterval: 30          # seconds between scaler checks (default 30)
  cooldownPeriod: 300          # seconds of no activity before 1 → 0 (default 300)
  fallback:                    # if the scaler fails N times in a row
    failureThreshold: 3
    replicas: 2
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 120
          policies:
          - type: Percent
            value: 50
            periodSeconds: 60
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: aws-podidentity
    metadata:
      queueURL: https://sqs.ap-southeast-1.amazonaws.com/111122223333/orders-q
      awsRegion: ap-southeast-1
      queueLength: "5"             # target messages per replica (default 5)
      activationQueueLength: "0"   # > this → wake from 0 (default 0)
      scaleOnInFlight: "true"      # count not-visible messages (default true)
```

Minimum IAM policy on the role the scaler uses:

```json
{
  "Effect": "Allow",
  "Action": "sqs:GetQueueAttributes",
  "Resource": "arn:aws:sqs:ap-southeast-1:111122223333:orders-q"
}
```

> **Two different identities.** The **keda-operator** only reads the queue size
> (`GetQueueAttributes`). The **worker pods** read and delete messages
> (`ReceiveMessage`, `DeleteMessage`) with **their own** ServiceAccount role.
> Don't give the KEDA role consume permissions, and don't expect KEDA to use the
> worker role unless you set `identityOwner: workload`.

## 3. What happens, step by step

1. **Producer sends messages** to `orders-q`.
2. **keda-operator watches** the ScaledObject and TriggerAuthentication in `orders`.
3. **Credentials.** The operator's ServiceAccount (`keda/keda-operator`) gets AWS
   credentials via IRSA (`AssumeRoleWithWebIdentity`) or Pod Identity. With
   `roleArn`, it then calls `sts:AssumeRole` into a per-team role.
4. **Poll.** Every `pollingInterval` the SQS scaler calls `GetQueueAttributes`:
   `ApproximateNumberOfMessages` (plus `…NotVisible` if `scaleOnInFlight`, plus
   `…Delayed` if `scaleOnDelayed`).
5. **Activation (0 ↔ 1).** If messages > `activationQueueLength`, the operator
   sets the Deployment to `minReplicaCount` or 1. When it stays inactive for
   `cooldownPeriod`, the operator sets it back to 0.
6. **HPA created.** On first reconcile KEDA creates `keda-hpa-worker` with an
   `External` metric, target type `AverageValue = queueLength`.
7. **HPA reads the metric** through the External Metrics API →
   `keda-operator-metrics-apiserver` → operator.
8. **1 ↔ N.** HPA formula: `desired = ceil(total messages / queueLength)`,
   limited by `maxReplicaCount` and the HPA `behavior`.
9. **Workers consume** with their own role and delete messages. The queue drops →
   the HPA scales down → after the cooldown KEDA goes to 0.

## 4. Authentication options for AWS scalers

| Option | How | When to pick |
| --- | --- | --- |
| Operator identity (default) | `podIdentity.provider: aws`. IRSA annotation / Pod Identity association on the `keda/keda-operator` SA | Single-team cluster, few queues. Simple, but one role reads everything |
| Operator assumes a role | `podIdentity.roleArn: <team-role>`. The KEDA role needs `sts:AssumeRole` on it; the team role trusts the KEDA role. Optional `externalID` (v2.20+) for cross-account | **Multi-tenant / production.** Each team owns a small read-only role. Also cross-account queues |
| Workload identity | `podIdentity.identityOwner: workload`. KEDA reads the scaled workload's SA annotation and assumes that role | Reuse the app's role; but the app role must also trust the keda-operator SA |
| Static keys | `secretTargetRef` to `awsAccessKeyID` / `awsSecretAccessKey` | Local labs only (kind). Avoid in production |
| `aws-eks` provider, `awsRoleArn`, trigger `identityOwner` | Old style | **Deprecated** since v2.13, removal planned for v3. Migrate to `provider: aws` |

## 5. Design choices

| Choice | Options | When to pick what |
| --- | --- | --- |
| ScaledObject vs ScaledJob | Scale a Deployment · spawn Jobs | Short messages, long-running consumer → ScaledObject. Long tasks that must not be killed on scale-down (video, scans, ML) → ScaledJob |
| KEDA vs plain HPA | KEDA trigger · HPA on CPU/memory | Load = backlog (queue, lag) → KEDA. CPU-bound web traffic → HPA (or KEDA's `cpu` trigger, which cannot go to 0) |
| minReplicaCount 0 or ≥ 1 | Scale to zero · always warm | 0 saves cost but adds a cold start (image pull, node scale-up by Karpenter/Cluster Autoscaler). Latency-sensitive → min 1 |
| queueLength | Messages per pod | Roughly what one pod handles in one polling window. Too low = flapping and too many pods; too high = the backlog grows |
| Several triggers | Several triggers in one ScaledObject | The HPA takes the **max** of all metrics. Good for "queue OR business-hours cron" |

## 6. Gotchas

- **Don't add your own HPA** for a Deployment that has a ScaledObject. Two HPAs
  fight; the webhook rejects it.
- **GitOps drift.** KEDA changes `spec.replicas`. If the chart sets `replicas`,
  ArgoCD shows OutOfSync and may scale back. Remove `replicas` from the manifest
  or add `ignoreDifferences` on `/spec/replicas`.
- **cooldownPeriod is only for 1 → 0.** Scale-down N → 1 follows the HPA
  `behavior` (default 300 s stabilization).
- **IRSA trust (`sub`).** The role trust must allow
  `system:serviceaccount:keda:keda-operator`, and the operator pod must be
  restarted after you annotate the ServiceAccount.
- **Scaler error = ScaledObject not Ready.** Without `fallback`, the HPA keeps
  the last value and KEDA cannot wake from 0. Check the
  `kubectl describe scaledobject` events.
- **Pausing.** Annotate `autoscaling.keda.sh/paused: "true"` (or
  `paused-replicas: "N"`) during incidents or maintenance instead of deleting the
  ScaledObject.
- **Upgrade notes.** v2.20 needs RBAC for `events.k8s.io`; v2.21 enforces
  ServiceAccount token audiences. Read the release notes before bumping the chart.
- **SQS numbers are approximate.** `ApproximateNumberOf…` can lag a few seconds.
  Fine for scaling, not for exact counts.

## 7. How to check yourself

```bash
CTX=<kube-context>; NS=orders; SO=worker

# KEDA installed and healthy
kubectl --context $CTX -n keda get deploy,pods
kubectl --context $CTX get crd | grep keda.sh

# ScaledObject status (READY / ACTIVE / FALLBACK / PAUSED) and the HPA it owns
kubectl --context $CTX -n $NS get scaledobject,hpa
kubectl --context $CTX -n $NS describe scaledobject $SO | sed -n '/Status/,$p'

# The external metric the HPA sees
kubectl --context $CTX get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/$NS/s0-aws-sqs-queue-orders-q?labelSelector=scaledobject.keda.sh%2Fname%3D$SO" | jq

# Auth: which role does the operator use?
kubectl --context $CTX -n keda get sa keda-operator -o yaml | grep -A2 annotations
kubectl --context $CTX -n keda exec deploy/keda-operator -- env | grep -E 'AWS_ROLE_ARN|AWS_CONTAINER_CREDENTIALS'

# Scaler errors
kubectl --context $CTX -n keda logs deploy/keda-operator --since=15m | grep -iE 'error|sqs'

# Queue depth from the AWS side
aws sqs get-queue-attributes --queue-url <url> --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

# Watch it scale
kubectl --context $CTX -n $NS get hpa,deploy/worker -w
```

The metric name (`s0-aws-sqs-queue-…`) is in
`kubectl get hpa keda-hpa-worker -o yaml` under
`spec.metrics[].external.metric.name`. Copy it from there if the path above
doesn't match.

## 8. Test yourself

<details>
<summary>Q1. Why does KEDA still create an HPA?</summary>

KEDA reuses the native HPA for 1 ↔ N. It only exposes the external metric and
handles 0 ↔ 1 itself, because the HPA cannot scale to or from zero.
</details>

<details>
<summary>Q2. The queue has 42 messages, queueLength 5, maxReplicaCount 6. How many pods?</summary>

ceil(42 / 5) = 9, capped at 6.
</details>

<details>
<summary>Q3. The Deployment stays at 0 though the queue has messages. What do you check?</summary>

`kubectl describe scaledobject` (READY/ACTIVE, events), the keda-operator logs
(AccessDenied?), the IAM role on the keda-operator ServiceAccount and its trust
`sub`, `queueURL`/`awsRegion`, and `activationQueueLength`.
</details>

<details>
<summary>Q4. cooldownPeriod is 300 s, but pods go from 8 to 3 in one minute. Why?</summary>

cooldownPeriod only controls 1 → 0. N → 1 is the HPA; tune it with
`advanced.horizontalPodAutoscalerConfig.behavior.scaleDown`.
</details>

<details>
<summary>Q5. Several teams share one cluster. How do you avoid one big KEDA role?</summary>

Each team has a small read-only role, and its TriggerAuthentication sets
`podIdentity.roleArn` to it. The KEDA role only has `sts:AssumeRole` on those
roles, and each team role trusts the KEDA role.
</details>

<details>
<summary>Q6. ArgoCD keeps showing the worker as OutOfSync. Why?</summary>

KEDA/HPA changed `spec.replicas`. Remove `replicas` from the manifest or ignore
`/spec/replicas` in the ArgoCD Application.
</details>

## Sources

- KEDA: [Scaling deployments](https://keda.sh/docs/latest/concepts/scaling-deployments/) · [Authentication](https://keda.sh/docs/latest/concepts/authentication/) · [AWS pod identity provider](https://keda.sh/docs/latest/authentication-providers/aws/) · [AWS SQS scaler](https://keda.sh/docs/latest/scalers/aws-sqs/) · [Troubleshooting](https://keda.sh/docs/latest/troubleshooting/) · [Releases](https://github.com/kedacore/keda/releases)
- Kubernetes: [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- AWS: [IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html) · [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) · [SQS GetQueueAttributes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html)
- ArgoCD: [Diffing customization](https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/)
