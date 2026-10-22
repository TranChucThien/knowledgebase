---
title: "EKS access for SSO users: Identity Center, access entries, access policies and RBAC"
date: 2026-10-21
tags: ["kubernetes", "eks", "aws", "iam", "rbac"]
summary: "From an SSO sign-in to an allowed kubectl call: how EKS maps an Identity Center role, and two ways to authorize it with EKS access policies or Kubernetes RBAC."
draft: false
---

"Give the read-only group kubectl access" sounds like a one-line change. On EKS
it involves three systems: IAM Identity Center, the EKS access configuration and
Kubernetes RBAC. This post follows one `kubectl` call through all of them. Roles
and AssumeRole are covered in [AWS IAM basics](../aws-iam-basics-assumerole-passrole/).

## TL;DR

- Every `kubectl` call answers two separate questions: **authentication** = who
  are you (AWS side), **authorization** = what can you do (EKS access policy
  and/or Kubernetes RBAC).
- A person never reaches the cluster directly. **IAM Identity Center** assigns a
  **permission set** per user per account; signing in gives temporary credentials
  of the IAM role `AWSReservedSSO_<set>_<suffix>`. **The cluster only sees that
  role**, not the person.
- The role is mapped into Kubernetes by an **access entry** (EKS API, preferred)
  or the **aws-auth ConfigMap** (legacy). In `API_AND_CONFIG_MAP` mode the
  **access entry wins**.
- Two ways to give the mapped role permissions: **Method 1** attach an **EKS
  access policy** to the entry (AWS-managed, e.g. `AmazonEKSAdminViewPolicy`);
  **Method 2** put the entry in a **Kubernetes group** and bind that group with
  **RBAC** (ClusterRoleBinding → ClusterRole). Both can be used together;
  permissions add up.
- Rules only **allow**; there is no deny. A request is allowed if **any**
  authorizer allows it, else `403 Forbidden`.

## The path of one kubectl call

1. The user signs in with SSO and gets credentials for
   `AWSReservedSSO_Read-Only-Access_<suffix>` in the cluster's account.
2. `kubectl` runs `aws eks get-token`: a signed STS `GetCallerIdentity` request.
3. **Authentication:** EKS checks the token and looks up the role ARN in the
   access entries (or aws-auth). Not found → `401 Unauthorized`.
4. The entry gives a Kubernetes **username** and **groups**.
5. **Authorization:** the EKS authorizer checks access policies on the entry
   (Method 1); Kubernetes RBAC checks bindings for the username/groups (Method 2).
   Neither allows → `403 Forbidden`.

## 1. Authentication vs authorization

| Step | Question | Who answers on EKS | Output |
| --- | --- | --- | --- |
| Authentication | Who are you? | EKS checks the token from `aws eks get-token`, then looks up the role ARN in access entries / aws-auth | Kubernetes **username** and **groups** |
| Authorization | Can you do this verb on this resource? | The **EKS authorizer** (access policies on the entry) and **Kubernetes RBAC** (groups → bindings → roles) | allow, or `403 Forbidden` |

An unmapped role fails with `Unauthorized` (401) at authentication. A mapped role
without permissions fails with `Forbidden` (403) at authorization.

## 2. From an SSO user to an IAM role

| Piece | Where | Note |
| --- | --- | --- |
| SSO user / group | IAM Identity Center (management account) | Who the person is |
| Permission set | Identity Center, e.g. `Read-Only-Access`, `DevOps-Engineer`, `AdministratorAccess` | Assigned as (user or group, permission set, **account**). Per account, not global |
| IAM role | Each target account: `AWSReservedSSO_<set>_<suffix>`, path `/aws-reserved/sso.amazonaws.com/<region>/` | Created by Identity Center when the set is provisioned. The suffix differs per account |
| Session name | Part of the assumed-role ARN (e.g. the user's email) | Visible in `kubectl auth whoami` and audit logs; not used for permissions |

So a new person who needs read access only needs the permission set in Identity
Center. **Nothing changes in the cluster.** And changing the cluster mapping
changes access for **everyone** with that permission set.

## 3. Authentication: access entry vs aws-auth

|  | Access entry | aws-auth ConfigMap |
| --- | --- | --- |
| Stored in | EKS API (console tab **Access**) | `kube-system/aws-auth`, `mapRoles` |
| Managed with | Console, `aws eks create-access-entry`, Terraform (EKS module v20+) | `kubectl edit`, Terraform EKS module v19 `aws_auth_roles`, eksctl |
| Role ARN format | **With** the path (`role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_…`) | **Without** the path (`role/AWSReservedSSO_…`) |
| Gives | Username, Kubernetes groups, **and** access policies | Username and groups only |
| Status | Recommended | Deprecated; a broken ConfigMap can lock nodes out |

Authentication modes: `CONFIG_MAP` (aws-auth only) → `API_AND_CONFIG_MAP`
(both; **access entries win** for the same principal) → `API` (entries only,
recommended). The change is one way: you cannot go back to `CONFIG_MAP`.

## 4. Kubernetes RBAC in one table

| Object | Scope | Purpose |
| --- | --- | --- |
| Role | One namespace | List of permissions in that namespace |
| ClusterRole | Whole cluster | List of permissions, including cluster-scoped resources (nodes, CRDs) |
| RoleBinding | One namespace | Gives a Role (or ClusterRole) to subjects, only in that namespace |
| ClusterRoleBinding | Whole cluster | Gives a ClusterRole to subjects everywhere |

```yaml
# ClusterRole: the permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: readonly
rules:
- apiGroups: ["*"]          # "" = core (pods, nodes, secrets), apps, keda.sh, ...
  resources: ["*"]
  verbs: ["get", "list", "watch"]
---
# ClusterRoleBinding: who gets them
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: readonly
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: readonly}
subjects:
- {apiGroup: rbac.authorization.k8s.io, kind: Group, name: readonly}
```

- Subjects: `User`, `Group` or `ServiceAccount`. For SSO roles, use a **Group**
  set on the access entry / aws-auth.
- **Allow only, additive.** `*`/`*` cannot "minus Secrets"; to exclude Secrets you
  must list the allowed resources.
- **Role and binding go together.** A role without a binding gives nobody
  anything. A binding to a missing role gives no permissions (and no error).
- Built-in ClusterRoles: `view` (read, no Secrets), `edit`, `admin`,
  `cluster-admin`. The group `system:masters` bypasses RBAC completely.

## 5. Two ways to authorize the same role

|  | Method 1: EKS access policy | Method 2: Kubernetes group + RBAC |
| --- | --- | --- |
| Where defined | AWS-managed policy attached to the access entry | ClusterRole / ClusterRoleBinding objects in the cluster |
| Checked by | EKS authorizer | Kubernetes RBAC authorizer |
| Custom rules | No (you cannot edit or create access policies) | Yes, any rules |
| Scope | Cluster or a list of namespaces | Cluster (ClusterRoleBinding) or namespace (RoleBinding) |
| Groups in `kubectl auth whoami` | Only `system:authenticated` | Includes the group (e.g. `readonly`) |
| Visible with `kubectl get clusterrolebinding` | **No**, check the Access tab / AWS CLI | Yes |
| Testable with `--as-group` impersonation | **No**, use a real session | Yes |
| Change / rollback | One click in the console | kubectl objects + the entry's group |

Access policies that matter for humans:

| Policy | Rules | Secrets |
| --- | --- | --- |
| `AmazonEKSViewPolicy` | Fixed list of workload resources, read only. **No nodes, no CRDs** | No |
| `AmazonEKSAdminViewPolicy` | `*`/`*` get, list, watch | **Yes** |
| `AmazonEKSSecretReaderPolicy` | `secrets` get, list, watch | Yes |
| `AmazonEKSEditPolicy` / `AmazonEKSAdminPolicy` | Write on most resources | – |
| `AmazonEKSClusterAdminPolicy` | `*` on everything (like `cluster-admin`) | Yes |

> `AmazonEKSAdminViewPolicy` has exactly the same rules as the `readonly`
> ClusterRole above (`*`/`*` get, list, watch). Method 1 and Method 2 give the
> same effective access; only the place where it is defined differs. The AWS docs
> suggest RBAC + Kubernetes groups when no access policy fits.

## 6. How each method is set up

**Method 1** (access policy):

1. EKS console → cluster → **Access** → IAM access entries → select
   `AWSReservedSSO_Read-Only-Access_…`.
2. **Access policies** → **Add access policy** → `AmazonEKSAdminViewPolicy`,
   scope **Cluster**.
3. Verify with a real Read-Only session (section 7).

```bash
aws eks associate-access-policy --profile <admin-profile> --region <region> --cluster-name <cluster> \
  --principal-arn arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/<sso-region>/AWSReservedSSO_Read-Only-Access_<suffix> \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy --access-scope type=cluster
```

**Method 2** (group + RBAC):

1. `kubectl apply` the ClusterRole + ClusterRoleBinding from section 4.
2. Access entry → **Edit** → Kubernetes groups = `readonly` (or aws-auth
   `groups: [readonly]` on older clusters).
3. Verify with `--as-group=readonly`, then with a real session.

## 7. How to check yourself

```bash
CTX=<context>; P=<profile>; R=<region>; CL=<cluster>
ARN=arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/<sso-region>/AWSReservedSSO_Read-Only-Access_<suffix>

# Who does the cluster think I am? (username, groups, role ARN)
kubectl --context $CTX auth whoami

# What can I do? (goes through access policies AND RBAC)
kubectl --context $CTX auth can-i list nodes
kubectl --context $CTX auth can-i list scaledobjects.keda.sh -A
kubectl --context $CTX auth can-i delete pods -A

# Auth mode, entries, groups and policies of one entry
aws eks describe-cluster --profile $P --region $R --name $CL --query 'cluster.accessConfig.authenticationMode'
aws eks list-access-entries --profile $P --region $R --cluster-name $CL
aws eks describe-access-entry --profile $P --region $R --cluster-name $CL --principal-arn $ARN
aws eks list-associated-access-policies --profile $P --region $R --cluster-name $CL --principal-arn $ARN

# RBAC side (Method 2) and the legacy mapping
kubectl --context $CTX get clusterrolebinding -o wide | grep -i readonly
kubectl --context $CTX get clusterrole readonly -o jsonpath='{.rules}'
kubectl --context $CTX -n kube-system get cm aws-auth -o jsonpath='{.data.mapRoles}'

# RBAC only: what would group readonly get? (does NOT include access policies)
kubectl --context <admin-ctx> auth can-i list nodes --as=test --as-group=readonly

# Test as Read-Only without a Read-Only context: borrow the token
TOK=$(aws eks get-token --profile <ro-profile> --region $R --cluster-name $CL --query status.token --output text)
kubectl --context <any-ctx-for-this-cluster> --token $TOK auth whoami
```

## 8. Gotchas

- **The access entry beats aws-auth.** Adding the same role to aws-auth on a
  cluster that has an entry for it does nothing.
- **ARN path:** access entries use the full role ARN with
  `/aws-reserved/sso.amazonaws.com/<region>/`; aws-auth needs it removed.
- **Stale aws-auth lines:** when a permission set is re-provisioned, the role
  suffix changes, and old aws-auth lines silently stop matching.
- **Read-only is not harmless:** `*`/`*` read includes Secrets; `view` /
  `AmazonEKSViewPolicy` still show ConfigMaps, env values and pod logs.
- **Methods add up:** keeping `AmazonEKSViewPolicy` next to
  `AmazonEKSAdminViewPolicy` changes nothing; removing one never removes what the
  other grants.
- **Two mechanisms = two places to look.** On a cluster that uses Method 1,
  `kubectl get clusterrolebinding` shows nothing; check the Access tab.
- **Keep it in code.** Access entries set by hand in the console and RBAC applied
  with `kubectl apply` are invisible in review. The Terraform EKS module v20+
  manages access entries; record any manual change in the ticket.

## 9. Example: two clusters, two methods

A common real-world mix inside one company:

| Cluster | Read-Only entry | Authorization | Result |
| --- | --- | --- | --- |
| cluster-a | Username `ReadOnlyAccess`, no group | `AmazonEKSViewPolicy` + `AmazonEKSAdminViewPolicy` | Full read, no write |
| cluster-b | Group `readonly` (also in aws-auth) | ClusterRoleBinding `readonly` → ClusterRole `readonly` | Full read, no write |

With only `AmazonEKSViewPolicy`, cluster-a returned `Forbidden` for nodes and for
CRDs like KEDA ScaledObjects or ExternalSecrets, which is exactly what someone
needs during a Karpenter or KEDA rollout. Adding `AmazonEKSAdminViewPolicy` fixed
it. Both clusters end up with the same access, defined in two different places.
Picking one method and managing it in Terraform avoids that confusion.

## 10. Test yourself

<details>
<summary>Q1. kubectl returns Unauthorized vs Forbidden. Which step failed each time?</summary>

Unauthorized (401) = authentication: the role is not mapped (no access entry, no
aws-auth line, or a wrong ARN). Forbidden (403) = authorization: mapped, but no
access policy or RBAC rule allows the action.
</details>

<details>
<summary>Q2. A new engineer needs read access. What do you change in the cluster?</summary>

Nothing. Assign the Read-Only-Access permission set for that account in IAM
Identity Center. The cluster only knows the role.
</details>

<details>
<summary>Q3. You add the role to aws-auth with group readonly, but nothing changes. Why?</summary>

The cluster runs `API_AND_CONFIG_MAP` and already has an access entry for that
role; the access entry wins, so the aws-auth line is ignored.
</details>

<details>
<summary>Q4. Why is AmazonEKSViewPolicy not enough for a Karpenter or KEDA rollout?</summary>

It is a fixed list of workload resources: no nodes and no CRDs. You need
`AmazonEKSAdminViewPolicy` (`*`/`*` read) or an RBAC ClusterRole.
</details>

<details>
<summary>Q5. --as-group=readonly says "no", but the real Read-Only user can list nodes. Why?</summary>

Impersonation only checks RBAC. On that cluster the permission comes from the EKS
access policy on the entry, which impersonation does not test. Test with a real
Read-Only session.
</details>

<details>
<summary>Q6. Can you give a role "everything except Secrets" with one rule?</summary>

No. RBAC and access policies only allow; there is no deny. You must list the
allowed resources (or use `view` / `AmazonEKSViewPolicy` plus extra rules for
nodes and CRDs).
</details>

## Sources

- EKS: [Access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html) · [Access policy permissions](https://docs.aws.amazon.com/eks/latest/userguide/access-policy-permissions.html) · [EKS IAM best practices](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html)
- SSO: [Configure an SSO user to access an EKS cluster](https://repost.aws/knowledge-center/eks-configure-sso-user)
- Kubernetes: [Using RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/) · [User-facing roles](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#user-facing-roles)
- CLI: [create-access-entry](https://docs.aws.amazon.com/cli/latest/reference/eks/create-access-entry.html) · [associate-access-policy](https://docs.aws.amazon.com/cli/latest/reference/eks/associate-access-policy.html)
