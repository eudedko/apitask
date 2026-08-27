# Kubernetes deployments

The `operators` directory installs one cluster-wide dependency —
[stakater/Reloader](https://github.com/stakater/Reloader) — with no Helm
chart. It must be applied once per cluster, before `base` or any overlay.

The `base` directory defines the proxy Deployment and Service, a MongoDB
`StatefulSet` running as a real replica set (its own PVC per member, a
headless Service for replica-set member addressing, and an ordinary
`ClusterIP` Service (`mongodb`) that the proxy and `credentials-rotator`
actually connect through — no operator involved), and an Ingress. It also
ships a
`credentials-rotator` CronJob that rotates the MongoDB app-user password
every minute (see "Credential rotation" below). The overlays customize
namespaces, images, application ports, database names, cache TTLs, proxy
replica counts, storage, MongoDB member counts, hosts, and Secret values.
MongoDB uses port `27017` in every environment.

MongoDB's replica set has 1 member in `dev` and 3 members in `staging` and
`production` — a single `MONGO_REPLICA_MEMBERS` value in `app-config` (`1`
by default, overridden to `3` in staging/production) drives both the
StatefulSet's `replicas` count and the bootstrap sidecar's peer list, so
they can never drift apart. 3 members tolerate one node down without losing
a primary (an even count, or a single node with no replica set at all,
either can't achieve a majority vote or can't fail over at all).

The `dev` overlay is tuned for **minikube on localhost**: it deletes the base
`Ingress` and exposes the proxy Service as `NodePort` on port `30300`. Staging
and production overlays keep the ClusterIP + Ingress shape and still expect an
ingress controller and (by default) cert-manager.

**Tradeoff:** this means `dev` does not exercise the Ingress path at all —
host-based routing, TLS termination, and cert-manager are only ever tested in
`staging`/`production`. The alternative (`minikube addons enable ingress` and
keeping the base `Ingress` in `dev`) would let `dev` validate the same path,
at the cost of extra one-time cluster setup and a local Ingress host/DNS
entry to manage for what's meant to be a disposable local loop. NodePort was
chosen to keep `dev` a zero-setup `kubectl apply -k` + `curl $(minikube ip):30300`
loop; Ingress-specific issues surface first in `staging`, not `dev`.

## Replica set bootstrap

MongoDB runs as a plain `StatefulSet` (`mongodb-statefulset.yaml`) — there is
no operator managing the replica set or user lifecycle. Members
authenticate to each other with a shared keyfile (`mongodb-keyfile` Secret,
mounted read-only and copied by an `fix-keyfile-perms` initContainer into an
`emptyDir` with the `0400` permissions `mongod` requires). Because rotating
the keyfile needs a coordinated restart of every member at once, it is
**not** rotated by `credentials-rotator` — only the app-user password is.

An always-on sidecar container, `rs-bootstrap`, owns every step that used to
be the image's implicit env-var-driven bootstrap or the old
`mongodb-init-configmap.yaml` init script (both gone now — unsafe once more
than one member exists, since the image's per-pod init script would run
independently, and unsafely, on every pod's first boot). A `postStart` hook,
an `initContainer`, or a one-shot `Job` were all considered and rejected:
none of them can wait on a not-yet-existing peer pod without either blocking
the main container's readiness or having no way to be triggered again once
that peer shows up. The sidecar instead loops forever, independent of the
main container, running an identical idempotent script
(`mongodb-bootstrap-configmap.yaml`) on every ordinal, gated by `POD_NAME`:

1. Wait for the local `mongod` to answer `ping`.
2. Only on ordinal 0: initiate the replica set if not already initiated,
   wait to become PRIMARY, then create the root user and the `github-proxy`
   app user (idempotently — "already exists" is treated as success, not an
   error). This is the only place the MongoDB "localhost exception" is
   used, and only until the root user exists.
3. Only on ordinal 0, forever: `rs.add()` any expected peer
   (`mongodb-<n>.mongodb-headless`, driven by `MONGO_REPLICA_MEMBERS`) that
   isn't already a member yet, over a `replicaSet=`-aware connection so the
   write always lands on the real PRIMARY even after a failover. This makes
   staging/production self-healing: peers 1 and 2 can come up well after
   peer 0 and still join.

`mongodb-service.yaml` sets `publishNotReadyAddresses: true` so a
not-yet-Ready peer's Pod DNS still resolves — otherwise `rs.add()` for a
brand new peer would be stuck in a chicken-and-egg wait.

## Credential rotation

The `credentials-rotator` CronJob runs every minute and does the whole
rotation itself, with no operator in the loop:

1. An `initContainer` generates a new random password and connects to
   MongoDB as root (`mongodb-root-credentials`), via a `replicaSet=`-aware
   URI so the write reaches the actual PRIMARY, to run
   `db.changeUserPassword()` against the `github-proxy` user. If this fails,
   the Job fails before ever touching the Secret.
2. The main container then patches the new password into
   `database-credentials` via `kubectl patch secret`.

Because MongoDB's password is changed *before* the Secret is patched, the
Secret always reflects a password MongoDB already accepts. `stakater/Reloader`
watches `database-credentials` (via the
`secret.reloader.stakater.com/reload` annotation on the proxy Deployment) and
triggers a rolling restart so the proxy picks up the current password.
Because the proxy Deployment's rolling update has `maxUnavailable: 0`, no
in-flight request loses authentication during the restart; any pod whose
Mongo connections briefly hit an authentication error before its restart
simply serves a cache miss (`server.js` treats all cache errors as
non-fatal), never a failed request.

This whole rotation completes in a few seconds, comfortably inside the
1-minute schedule — the previous operator-based design needed the operator's
reconcile loop to notice a Secret change and rewrite a second, operator-owned
connection-string Secret, which routinely took longer than a minute and is
why rotation had been slowed to every 2 minutes.

On first boot, `database-credentials` starts from a placeholder (overridden
per overlay in `secrets-patch.yaml`); the `rs-bootstrap` sidecar creates the
`github-proxy` user from that seed value as soon as the replica set has a
PRIMARY, so the proxy authenticates on its very first start — no manual
bootstrap step is needed after `kubectl apply -k ...`.

## Configure before applying

1. Install the cluster-wide Reloader dependency once, before applying `base`
   or any overlay:

   ```sh
   kubectl apply -k k8s/operators
   ```

   This is a one-time step per cluster — it is not part of any overlay and
   is not re-applied when you deploy `dev`/`staging`/`production`.
2. Build the local image with the tag used by the selected overlay:

   ```sh
   docker build -f Containerfile -t github-api-proxy:dev .
   ```

   Use `github-api-proxy:staging` or `github-api-proxy:1.0.0` for the other
   overlays. Load the image into the local cluster when its container runtime
   does not share the host Docker image store. MongoDB's image is pulled
   directly from Docker Hub — it needs no local build or image load step.
3. Replace every `replace-with-*` value in the selected overlay's
   `secrets-patch.yaml`. The overlay needs to patch `database-credentials`
   (the MongoDB app-user password, rotated every minute),
   `mongodb-root-credentials` (the MongoDB root user, not rotated),
   `mongodb-keyfile` (the replica set's internal auth key, not rotated —
   generate with `openssl rand -base64 756`), and `github-api-credentials`
   (the GitHub token). Committed placeholder values are not suitable for a
   real cluster; use an external secret-management workflow in production.
4. Change the Ingress host and `ingressClassName` if the cluster does not use
   the NGINX Ingress controller.
5. Ensure the cluster has an Ingress controller and a default StorageClass.

## Render and deploy

Render first to review the exact resources:

```sh
kubectl kustomize k8s/operators
kubectl kustomize k8s/overlays/dev
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production
```

Apply the operators once per cluster, then one overlay:

```sh
kubectl apply -k k8s/operators
kubectl apply -k k8s/overlays/dev
```

The default hosts are `staging.api-proxy.example.com` and
`api-proxy.example.com`. The `dev` overlay has no Ingress — see "Local dev on
minikube" below. The generated ConfigMap name hash and the
`secret.reloader.stakater.com/reload` annotation both trigger pod-template
updates when their respective values change, so config and credential
changes always reach running pods without a manual restart.

## Local dev on minikube

The `dev` overlay is designed to run on a local minikube cluster and expose the
proxy directly on the node's NodePort — no ingress controller, DNS, or TLS
setup required.

```sh
# Start minikube if it is not already running
minikube start

# Install Reloader once per cluster
kubectl apply -k k8s/operators

# Build the image directly into minikube's container runtime
eval $(minikube docker-env)
docker build -f Containerfile -t github-api-proxy:dev .
# Alternative when not using docker-env:
#   docker build -f Containerfile -t github-api-proxy:dev .
#   minikube image load github-api-proxy:dev

# Fill in real values in k8s/overlays/dev/secrets-patch.yaml
#   database-credentials.password       (MongoDB app-user password, rotated every minute)
#   mongodb-root-credentials.username/password (MongoDB root user, not rotated)
#   mongodb-keyfile.key                 (replica set internal auth key, not rotated)
#   github-api-credentials.token        (GitHub token, or empty for anon)

# Render to sanity-check — Ingress should be absent, github-api-proxy Service
# should be NodePort with nodePort: 30300
kubectl kustomize k8s/overlays/dev

# Apply
kubectl apply -k k8s/overlays/dev

# Watch the sidecar bootstrap the single-member replica set
kubectl logs -n github-api-proxy-dev mongodb-0 -c rs-bootstrap -f

# Confirm exactly one PRIMARY member
kubectl exec -n github-api-proxy-dev mongodb-0 -c mongodb -- \
  mongosh --quiet --eval "rs.status().members.map(m => ({name: m.name, state: m.stateStr}))"

# Hit the proxy from the host
curl "http://$(minikube ip):30300/github/repos/anthropics/anthropic-sdk-python" -i
# Cross-driver-safe alternative (opens a localhost tunnel on some drivers):
#   minikube service -n github-api-proxy-dev github-api-proxy --url
```

A second identical `curl` within `CACHE_TTL_SECONDS` (60s in dev) returns
`X-Cache: HIT`. Watch `kubectl get pods -n github-api-proxy-dev -w` across a
rotation cycle to see the proxy pods roll one at a time with no dropped
requests.
