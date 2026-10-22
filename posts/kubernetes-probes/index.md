---
title: "Readiness vs liveness probes: stop restarting healthy pods"
date: 2026-10-05
tags: ["kubernetes", "reliability", "observability"]
summary: "Liveness probes that check dependencies turn a slow database into a cluster-wide restart storm. What each probe is for and a config that survives real incidents."
draft: false
---

Kubernetes gives you three probes, and mixing up their purposes is one of the
most common causes of self-inflicted outages I've seen.

## What each probe answers

| Probe       | Question                                  | On failure                          |
|-------------|-------------------------------------------|-------------------------------------|
| `startupProbe`   | Has the app finished booting?        | Keep waiting, then kill the container |
| `readinessProbe` | Should this pod receive traffic now? | Remove pod from Service endpoints   |
| `livenessProbe`  | Is the process irrecoverably stuck?  | **Restart** the container           |

The key word is *restart*. A liveness failure is destructive, so it should only
fire for problems a restart actually fixes: deadlocks, a wedged event loop,
exhausted internal state.

## The anti-pattern

```yaml
livenessProbe:
  httpGet:
    path: /health   # checks DB + Redis + downstream API
    port: 8080
  periodSeconds: 5
  failureThreshold: 2
```

When the database has a 20-second hiccup, **every** replica fails liveness at
the same time, Kubernetes restarts all of them, and the cold-start herd hits the
database just as it recovers. A short incident becomes a long one.

## A safer configuration

### Separate endpoints

- `/livez` checks only in-process state. No network calls.
- `/readyz` checks the dependencies required to serve a request.

```go
http.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK) // the handler ran, so the loop is alive
})

http.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        http.Error(w, "db unavailable", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
})
```

### Probe spec

```yaml
startupProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 5
  failureThreshold: 24      # up to 2 minutes to boot
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
  periodSeconds: 5
  failureThreshold: 2
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 6       # a full minute of being stuck
```

## Verifying it

Watch endpoints while you break a dependency:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=my-api -w
kubectl get pods -l app=my-api -w   # RESTARTS should stay at 0
```

Pods should drop out of the endpoint slice and come back, without restarting.

## Takeaways

1. Liveness = "restart me". Keep it dependency-free.
2. Readiness = "don't send me traffic". This is where dependency checks belong.
3. Use `startupProbe` for slow boots instead of a huge `initialDelaySeconds`.
