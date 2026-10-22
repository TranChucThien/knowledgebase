---
title: "OTel Collector in Kubernetes: how logs and metrics are collected"
date: 2026-10-08
tags: ["kubernetes", "opentelemetry", "observability", "prometheus"]
summary: "Agent, cluster collector and gateway: how OpenTelemetry collectors pull and receive data, discover pods to scrape, and which filters decide what reaches the backend."
draft: false
---

A typical OpenTelemetry setup on Kubernetes (for example the Coralogix
`otel-integration` Helm chart, but most vendor charts look the same) runs
several collectors per cluster. They are the same binary with different
configs. This post walks through what each one does, how data flows inside a
collector, and why a metric you expect sometimes never shows up.

## TL;DR

- The chart runs **three collectors** per cluster: an **agent** on every node,
  one **cluster collector**, and a **gateway** for traces.
- Inside each collector, data flows through **pipelines**: receivers →
  processors (in order) → exporters. Only exporters send data out.
- Receivers either **pull** (read files, call the kubelet, scrape `/metrics`)
  or **listen** for apps that **push** (OTLP, statsd, Zipkin).
- Pod metrics are found by **service discovery** plus **relabel rules** that
  keep pods annotated `prometheus.io/scrape: "true"`.
- Data reaches the backend only if it passes **two filter layers**: target
  relabeling, then the processor allowlist/denylist.

## 1. Big picture: three collectors

|  | Agent | Cluster collector | Gateway |
| --- | --- | --- | --- |
| Runs as | DaemonSet, one per node | Deployment, **one** per cluster | Deployment, several replicas (HPA) |
| Scope | what happens **on its node** | what is true for the **whole cluster** | traces from all agents |
| Data | pod logs, pod/node usage, app metrics, incoming traces | replicas, pod phase, restarts, node conditions, k8s events, object inventory | traces after `tail_sampling` |

Why exactly one cluster collector: cluster-level receivers must run **once per
cluster**, otherwise every metric is duplicated and the API server gets extra
load ([k8s_cluster README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/k8sclusterreceiver/README.md)).

## 2. Inside a collector: the pipeline model

One collector pod is **one process** with five kinds of components. A component
runs only if `service.pipelines` uses it, and processors run **in the listed
order** ([Collector configuration](https://opentelemetry.io/docs/collector/configuration/)).

| Component | Job | Examples |
| --- | --- | --- |
| Receiver | Gets data in (pull or push) | `filelog`, `kubeletstats`, `hostmetrics`, `prometheus`, `otlp` |
| Processor | Changes or drops data, in order | `memory_limiter`, `k8sattributes`, `filter/include-metrics`, `batch` |
| Exporter | **Sends** data out (processors never send) | vendor exporter, `otlp`, `loadbalancing` |
| Connector | Exporter of one pipeline and receiver of another | `spanmetrics` (traces → metrics) |
| Extension | Not in the data path | `health_check`, `file_storage`, `pprof` |

Typical agent pipelines:

| Pipeline | For | Goes to |
| --- | --- | --- |
| `logs` | container logs on the node + logs pushed by apps | backend |
| `metrics` | pod/node usage, scraped app metrics, pushed metrics, metrics made from traces | backend (after the allowlist) |
| `traces` | spans from apps; also turned into RED metrics by `spanmetrics` | gateway, routed by `traceID` |

## 3. How receivers get their data: pull or push

**Rule of thumb:** an `endpoint` on the collector's **own pod IP**
(`${env:MY_POD_IP}:<port>`) means it **listens**, so apps **push**. A
`collection_interval`, `scrape_configs`, file paths or an endpoint on **another
host** (node IP, service DNS) means it **pulls**.

| Receiver | Type | Reads from | What makes it possible |
| --- | --- | --- | --- |
| `filelog` | pull | `/var/log/pods/*/*/*.log` | hostPath `/var/log/pods` (read-only) |
| `hostmetrics` | pull, 30 s | node `/proc`, `/sys`: cpu, disk, filesystem, load, memory, network | hostPath `/` mounted at `/hostfs` + `root_path: /hostfs` ([README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/README.md)) |
| `kubeletstats` | pull, 30 s | `https://<nodeIP>:10250/stats/summary` | ServiceAccount token + RBAC `nodes/stats` ([README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/kubeletstatsreceiver/README.md)) |
| `prometheus` | pull | annotated pods on its node, kube-state-metrics, its own `:8888` | RBAC list/watch pods + network to pod IPs (section 4) |
| `otlp`, `statsd`, `jaeger`, `zipkin` | push | apps send to `<agentPodIP>:4317/4318`, `:8125`, `:9411` | app configured with the agent address |
| `k8s_cluster`, `k8sobjects` (cluster collector) | pull (watch) | API server: deployments, pods, nodes, events | RBAC get/list/watch on those objects |

Charts usually add these mounts and RBAC rules automatically when a preset is
enabled (`logsCollection`, `hostMetrics`, `kubeletMetrics`, `clusterMetrics`).

## 4. Scraping app metrics from annotated pods

The flow, step by step:

1. The agent's `prometheus` receiver **lists and watches pods** on the API server.
2. The API server returns every pod with temporary `__meta_*` labels.
3. **Relabel rules** keep only pods on the same node that opted in, and build the
   URL from pod IP + port + path.
4. Every scrape interval the agent calls `GET http://<podIP>:<port>/<path>` and
   gets Prometheus text format back.
5. The metrics, plus `up` and `scrape_duration_seconds`, go into the metrics pipeline.

### Step 1: Service discovery

`kubernetes_sd_configs` with `role: pod` turns **every pod** into a target
(address = pod IP) with temporary labels. `.` and `/` in names become `_`
([kubernetes_sd_config](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#kubernetes_sd_config)).

| Meta label | Example |
| --- | --- |
| `__address__` | `10.1.25.37:8080` |
| `__meta_kubernetes_namespace` | `shop` |
| `__meta_kubernetes_pod_node_name` | node of the pod |
| `__meta_kubernetes_pod_annotation_prometheus_io_scrape` | `true` |
| `__meta_kubernetes_pod_label_app` | `api` |

### Step 2: Relabel rules

Rules run top to bottom. `__address__` (host:port) and `__metrics_path__`
(default `/metrics`) decide the URL; labels starting with `__` are removed
afterwards ([relabel_config](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#relabel_config)).

| # | Rule | Effect |
| --- | --- | --- |
| 1 | `keep` node name = `${env:K8S_NODE_NAME}` | only pods on **this agent's node** |
| 2 | `drop` `app.kubernetes.io/name` = `opentelemetry.*` | skip the collector's own pods |
| 3 | `keep` annotation `prometheus.io/scrape` = `true` | **only pods that opted in** |
| 4 | annotation `prometheus.io/path` → `__metrics_path__` | custom path |
| 5 | pod IP + annotation `prometheus.io/port` → `__address__` | custom port (written `$${1}:$${2}`, because `$` is escaped as `$$` in collector config, see the [prometheus receiver README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/prometheusreceiver/README.md)) |
| 6–8 | `labelmap` pod labels; add `kube_namespace`, `pod` | labels on every metric |

### Step 3: Scrape

A `GET` on the final URL returns Prometheus text format. The receiver also adds
`up` and `scrape_duration_seconds` per target and converts everything to OTel
metrics.

**Example:** a pod template with `prometheus.io/scrape: "true"`,
`prometheus.io/path: "/worker-metrics"` and `prometheus.io/port: "9000"` becomes
the target `http://<podIP>:9000/worker-metrics`.

### Why the "same node" rule matters

Every agent on every node runs the same config. Without rule 1, each of them
would scrape every pod in the cluster, and every metric would be sent once per
node. The receiver docs warn that identical replicas scrape twice and that
sharding is your job.

Check that this rule really exists in your **rendered** config, and that it is
in git, not only in a live object. A manual patch disappears on the next GitOps
sync.

### About `prometheus.io/*`

This is a **community convention**, not a Kubernetes feature. Kubernetes stores
any annotation; only the scrape config gives it meaning. The official Prometheus
example now uses neutral names like `example.io/should_be_scraped`
([prometheus-kubernetes.yml](https://github.com/prometheus/prometheus/blob/main/documentation/examples/prometheus-kubernetes.yml),
[Chronosphere docs](https://docs.chronosphere.io/ingest/metrics-traces/collector/discover/scrape-configuration)).

## 5. What reaches the backend: two filter layers

Receivers only collect what they are configured to read; processors then keep or
drop **differently per signal**:

| Signal | Typical filter | Effect |
| --- | --- | --- |
| Logs | **Denylist**, e.g. drop namespaces `argocd`, `monitoring` | almost everything is sent |
| Metrics | **Allowlist** `filter/include-metrics` | a new metric is dropped until you add it |
| Traces | none in the agent; gateway `tail_sampling` keeps errors, slow traces, a share of OK ones | sampled |

`memory_limiter` can also refuse data when the collector is above its memory limit.

**Debug a missing metric with `up{pod="<pod>"}`:**

- no series → layer 1 (the pod is not a target: annotation, node rule, RBAC);
- `up = 0` → wrong port/path, or the app serves no metrics;
- `up = 1` but the metric is missing → layer 2, the allowlist.

## 6. The cluster collector in detail

The API server holds **state**, not metrics; collectors turn state into numbers.
Where each kind of data really comes from:

| Data | Produced by | Read by |
| --- | --- | --- |
| Node CPU, memory, disk | Linux kernel, virtual files `/proc`, `/sys` | agent `hostmetrics` via `/hostfs` |
| Container logs | container runtime (containerd) writes stdout/stderr to `/var/log/pods/...` | agent `filelog` |
| Pod / container usage | kubelet (cAdvisor + runtime stats) at `:10250/stats/summary` | agent `kubeletstats` |
| Pod list, labels, names | API server (from etcd) | agent: service discovery + `k8sattributes` (**metadata only**) |
| **Cluster state** (replicas, phase, restarts, node conditions) | controllers and kubelets write `.status` to the API server | cluster collector `k8s_cluster` (kube-state-metrics does the same) |
| Events | controllers / kubelet create `Event` objects | cluster collector `k8sobjects` |

Example conversion: a Deployment with `spec.replicas: 3` and
`status.availableReplicas: 2` becomes `k8s.deployment.desired = 3` and
`k8s.deployment.available = 2`. A pod with `restartCount: 5` becomes
`k8s.container.restarts = 5`.

- `k8s_cluster` **watches the API server** and emits object state as metrics
  every 30 s.
- `k8sobjects` watches `events` and lists namespaces, nodes, pods and deployments.
- An extra `prometheus` receiver can use `role: endpoints` (API server metrics)
  and `role: node` (`/metrics/cadvisor`).

**Gotcha:** the cluster collector has its own `filter/include-metrics`. If that
allowlist is narrow, restart and replica metrics are collected and then
**dropped**. Widening it is often the cheapest way to get pod restart metrics.

## 7. Checklist: get a new app's metrics to the backend

1. The container serves Prometheus text format on a port/path (test with
   `curl http://<podIP>:<port>/metrics`), or the app pushes OTLP to the agent
   (`<nodeAgentIP>:4317`).
2. Add the three `prometheus.io/*` annotations to the pod template.
3. Add the metric names to the agent's `filter/include-metrics`.
4. Deploy through your normal GitOps path.
5. Check `up{kube_namespace="<ns>"}` = 1, then the metric itself.

## 8. How to check yourself

```bash
# Rendered collector configs (the real pipelines and filters)
kubectl -n <otel-ns> get cm <agent-configmap> -o jsonpath='{.data.relay}'
kubectl -n <otel-ns> get cm <cluster-collector-configmap> -o jsonpath='{.data.relay}'

# Pods that opted in to scraping, per namespace
kubectl get pods -A -o jsonpath='{range .items[?(@.metadata.annotations.prometheus\.io/scrape=="true")]}{.metadata.namespace}{"\n"}{end}' | sort | uniq -c

# Host mounts and RBAC of the agent
kubectl -n <otel-ns> get ds <agent-daemonset> -o jsonpath='{range .spec.template.spec.volumes[*]}{.name} -> {.hostPath.path}{"\n"}{end}'
kubectl get clusterrole <agent-clusterrole> -o jsonpath='{range .rules[*]}{.resources} {.verbs}{"\n"}{end}'
```

```txt
# PromQL
up{job="kubernetes-pods", kube_namespace="shop"}
count by (__name__) ({job="kubernetes-pods", kube_namespace="shop"})
```

## Sources

- OpenTelemetry: [Collector configuration](https://opentelemetry.io/docs/collector/configuration/), receivers [prometheus](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/prometheusreceiver/README.md), [hostmetrics](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/README.md), [kubeletstats](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/kubeletstatsreceiver/README.md), [k8s_cluster](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/k8sclusterreceiver/README.md)
- Prometheus: [kubernetes_sd_config](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#kubernetes_sd_config), [relabel_config](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#relabel_config), [prometheus-kubernetes.yml](https://github.com/prometheus/prometheus/blob/main/documentation/examples/prometheus-kubernetes.yml)
- [Chronosphere: scrape configuration using Kubernetes](https://docs.chronosphere.io/ingest/metrics-traces/collector/discover/scrape-configuration)
