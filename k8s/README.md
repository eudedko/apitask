# Kubernetes deployments

The `base` directory defines the proxy Deployment and Service, a single-replica
MongoDB Deployment with a persistent volume and ClusterIP Service, an Ingress,
and a NetworkPolicy that only permits proxy pods to reach MongoDB. The overlays
customize namespaces, images, application ports, database names, cache TTLs,
proxy replica counts, storage, hosts, and Secret values. MongoDB uses port
`27017` in every environment.

## Configure before applying

1. Build the local image with the tag used by the selected overlay:

   ```sh
   docker build -f Containerfile -t github-api-proxy:dev .
   ```

   Use `github-api-proxy:staging` or `github-api-proxy:1.0.0` for the other
   overlays. Load the image into the local cluster when its container runtime
   does not share the host Docker image store.
2. Replace every `replace-with-*` value in the selected overlay's
   `secrets-patch.yaml`. The base contains explicit `database-credentials` and
   `github-api-credentials` Secret manifests, and each overlay patches their
   `stringData` values. Committed placeholder values are not suitable for a
   real cluster; use an external secret-management workflow in production.
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
