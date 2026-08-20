# Kubernetes deployments

The `base` directory defines the proxy Deployment and Service, a single-replica
MongoDB Deployment with a persistent volume and ClusterIP Service, an Ingress,
and a NetworkPolicy that only permits proxy pods (and the rotator) to reach
MongoDB. It also ships a `credentials-rotator` CronJob that rotates the
`database-credentials` Secret every minute (see "Credential rotation" below).
The overlays customize namespaces, images, application ports, database names,
cache TTLs, proxy replica counts, storage, hosts, and Secret values. MongoDB
uses port `27017` in every environment.

## Credential rotation

The `credentials-rotator` CronJob replaces the MongoDB user the proxy
authenticates as every minute. Each cycle creates a new versioned user
(`github-proxy-vN` with `readWrite` scoped to `github_proxy`), patches the
`database-credentials` Secret, triggers a rolling restart of the proxy
Deployment, and drops the user from two cycles ago. Old and new users co-exist
in MongoDB across the rollout, so no in-flight request loses authentication.

The rotator authenticates to MongoDB as root, using a **separate** Secret
called `rotator-mongodb-credentials` which is **not** rotated. Each overlay
patches its password. This Secret also drives `MONGO_INITDB_ROOT_*` on the
MongoDB pod, so first-time cluster init still seeds a root user.

On a fresh deploy the app Deployment CrashLoopBackOffs for up to a minute until
the first CronJob cycle populates `database-credentials`. To skip that gap:

```sh
kubectl -n <ns> create job --from=cronjob/credentials-rotator bootstrap
```

immediately after `kubectl apply -k ...`.

## Configure before applying

1. Build the local image with the tag used by the selected overlay:

   ```sh
   docker build -f Containerfile -t github-api-proxy:dev .
   ```

   Use `github-api-proxy:staging` or `github-api-proxy:1.0.0` for the other
   overlays. Load the image into the local cluster when its container runtime
   does not share the host Docker image store.
2. Replace every `replace-with-*` value in the selected overlay's
   `secrets-patch.yaml`. The base contains explicit `database-credentials`,
   `github-api-credentials`, and `rotator-mongodb-credentials` Secret
   manifests. The overlay only needs to patch `rotator-mongodb-credentials`
   (the MongoDB root password, unrotated) and `github-api-credentials`
   (the GitHub token); `database-credentials` starts with a placeholder value
   and is overwritten by the first successful rotation. Committed placeholder
   values are not suitable for a real cluster; use an external
   secret-management workflow in production.
3. Change the Ingress host and `ingressClassName` if the cluster does not use
   the NGINX Ingress controller.
4. Ensure the cluster has an Ingress controller and a default StorageClass.

## Render and deploy

Render first to review the exact resources:

```sh
kubectl kustomize k8s/overlays/dev
kubectl kustomize k8s/overlays/staging
kubectl kustomize k8s/overlays/production
```

Apply one installation:

```sh
kubectl apply -k k8s/overlays/dev
```

The default hosts are `dev.api-proxy.example.com`,
`staging.api-proxy.example.com`, and `api-proxy.example.com`. The generated
ConfigMap name hash triggers pod-template updates when its values change.
Explicit Secret updates do not automatically restart existing pods.
