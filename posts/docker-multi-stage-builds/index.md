---
title: "Shrinking Docker images with multi-stage builds"
date: 2026-09-14
tags: ["docker", "ci-cd", "performance"]
summary: "How I took a Node.js image from 1.1 GB to 140 MB by separating build and runtime stages, and the caching tricks that make CI builds fast."
draft: false
---

A Docker image that ships a compiler, a package cache and your test fixtures to
production is slow to pull, slow to scan, and gives an attacker more tools to
work with. Multi-stage builds fix this by letting one Dockerfile describe both
the **build environment** and a minimal **runtime environment**.

## The single-stage baseline

This is the kind of Dockerfile most projects start with:

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
CMD ["node", "dist/server.js"]
```

It works, but the final image contains `devDependencies`, the full Debian
toolchain and the source tree:

```bash
$ docker images my-api
REPOSITORY   TAG       SIZE
my-api       latest    1.12GB
```

## Splitting build and runtime

### Stage 1: build

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-bookworm AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached
# until package*.json actually changes.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build && npm prune --omit=dev
```

### Stage 2: runtime

```dockerfile
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Only what `COPY --from=build` names ends up in the final image.

## Results

| Variant                   | Size    | Cold CI build |
|---------------------------|---------|---------------|
| Single stage              | 1.12 GB | 3m 40s        |
| Multi-stage, slim runtime | 212 MB  | 3m 05s        |
| + cache mounts, `npm ci`  | 212 MB  | 58s (warm)    |
| + distroless runtime      | 141 MB  | 58s (warm)    |

## Making it fast in CI

BuildKit cache mounts only live on the builder, so on ephemeral CI runners
export the cache to the registry instead:

```bash
docker buildx build \
  --cache-from type=registry,ref=ghcr.io/me/my-api:buildcache \
  --cache-to   type=registry,ref=ghcr.io/me/my-api:buildcache,mode=max \
  -t ghcr.io/me/my-api:$(git rev-parse --short HEAD) \
  --push .
```

> `mode=max` caches the layers of intermediate stages too. Without it, only
> the final stage is cached and the expensive `npm ci` layer is rebuilt every time.

## Checklist

- Order instructions from least to most frequently changing.
- Add a `.dockerignore` (`node_modules`, `.git`, test data).
- Run as a non-root user in the runtime stage.
- Target a stage locally with `docker build --target build .` when debugging.

Related: [Readiness vs liveness probes](../kubernetes-probes/) covers what happens
after this image is deployed.
