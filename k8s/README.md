# Kubernetes deployments

The `operators` directory installs cluster-wide dependencies — [MongoDB
Controllers for Kubernetes](https://github.com/mongodb/mongodb-kubernetes)
(MCK) and [stakater/Reloader](https://github.com/stakater/Reloader) — with no
Helm chart. It must be applied once per cluster, before `base` or any overlay
(see "Configure before applying" below).

The `base` directory defines the proxy Deployment and Service, a
`MongoDBCommunity` custom resource (reconciled by MCK into a single-member
replica set with its own PVC and headless Service), and an Ingress. It also
ships a drastically simplified `credentials-rotator` CronJob that rotates the
`database-credentials` Secret every 2 minutes (see "Credential rotation"
below). The overlays customize namespaces, images, application ports,
database names, cache TTLs, proxy replica counts, storage, hosts, and Secret
values. MongoDB uses port `27017` in every environment.

The `dev` overlay is tuned for **minikube on localhost**: it deletes the base
`Ingress` and exposes the proxy Service as `NodePort` on port `30300`. Staging
and production overlays keep the ClusterIP + Ingress shape and still expect an
ingress controller and (by default) cert-manager.

## Credential rotation

MCK owns MongoDB user lifecycle: the `MongoDBCommunity` resource in
`mongodb-community.yaml` declares the `github-proxy` user with a
`passwordSecretRef` of `database-credentials` (the password seed, read-only
from MCK's perspective), a `scramCredentialsSecretName`, and a
`connectionStringSecretName` of `database-credentials-connection`. These two
Secrets are deliberately separate: MCK only *writes* `connectionString.*`
keys into a Secret it created itself, and refuses to touch one that already
exists and isn't operator-owned (it logs "connection string secret ... is
not managed by the operator" and skips the write). Reusing
`database-credentials` for both would mean it's created by kustomize, not by
MCK, so the connection-string keys would never appear. `database-credentials-connection`
is never declared as a manifest — MCK creates it on first reconcile and owns
it from then on.

The `credentials-rotator` CronJob's only job is to generate a new random
password and patch it into `database-credentials` every 2 minutes — it
never talks to MongoDB or the Kubernetes Deployment API directly, so its
RBAC is `get`+`patch` on that one Secret (`kubectl patch` needs `get` too).
MCK picks up the change, re-derives SCRAM credentials, and rewrites
`database-credentials-connection` with the new password embedded in the
connection string. Reloader watches `database-credentials-connection` (via
the `secret.reloader.stakater.com/reload` annotation on the proxy
Deployment) and triggers a rolling restart so the proxy always authenticates
with the current password. Because the proxy Deployment's rolling update has
`maxUnavailable: 0`, no in-flight request loses authentication during the
restart.

On first boot, `database-credentials` starts from a placeholder
(overridden per overlay in `secrets-patch.yaml`); MCK creates the
`github-proxy` user from that seed value immediately, so the proxy
authenticates on its very first start — no manual bootstrap step is needed
after `kubectl apply -k ...`.

## Configure before applying

1. Install the cluster-wide operators once, before applying `base` or any
   overlay, and wait for the `MongoDBCommunity` CRD to become usable:

   ```sh
   kubectl apply -k k8s/operators
   kubectl wait --for=condition=established crd/mongodbcommunity.mongodbcommunity.mongodb.com
   ```

   This is a one-time step per cluster — it is not part of any overlay and
   is not re-applied when you deploy `dev`/`staging`/`production`.
2. Build the local image with the tag used by the selected overlay:

   ```sh
   docker build -f Containerfile -t github-api-proxy:dev .
   ```

   Use `github-api-proxy:staging` or `github-api-proxy:1.0.0` for the other
   overlays. Load the image into the local cluster when its container runtime
   does not share the host Docker image store.
3. Replace every `replace-with-*` value in the selected overlay's
   `secrets-patch.yaml`. The overlay only needs to patch
   `database-credentials` (the MongoDB app-user password, rotated every
   2 minutes) and `github-api-credentials` (the GitHub token);
   `database-credentials-connection` is populated entirely by MCK from the
   seed and never edited directly. Committed placeholder values are not
   suitable for a real cluster; use an external secret-management workflow
   in production.
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
kubectl wait --for=condition=established crd/mongodbcommunity.mongodbcommunity.mongodb.com
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

# Install the operators once per cluster and wait for the CRD
kubectl apply -k k8s/operators
kubectl wait --for=condition=established crd/mongodbcommunity.mongodbcommunity.mongodb.com

# Build the image directly into minikube's container runtime
eval $(minikube docker-env)
docker build -f Containerfile -t github-api-proxy:dev .
# Alternative when not using docker-env:
#   docker build -f Containerfile -t github-api-proxy:dev .
#   minikube image load github-api-proxy:dev

# Fill in real values in k8s/overlays/dev/secrets-patch.yaml
#   database-credentials.password (MongoDB app-user password, rotated)
#   github-api-credentials.token       (GitHub token, or empty for anon)

# Render to sanity-check — Ingress should be absent, github-api-proxy Service
# should be NodePort with nodePort: 30300
kubectl kustomize k8s/overlays/dev

# Apply
kubectl apply -k k8s/overlays/dev

# Hit the proxy from the host
curl "http://$(minikube ip):30300/github/repos/anthropics/anthropic-sdk-python" -i
# Cross-driver-safe alternative (opens a localhost tunnel on some drivers):
#   minikube service -n github-api-proxy-dev github-api-proxy --url
```

A second identical `curl` within `CACHE_TTL_SECONDS` (60s in dev) returns
`X-Cache: HIT`.
