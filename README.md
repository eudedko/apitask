# github-api-proxy

Read-only proxy in front of `api.github.com` with MongoDB caching, packaged for
Docker Compose and Kubernetes (Kustomize: `dev` / `staging` / `production`).
A CronJob rotates the MongoDB credentials the proxy uses every minute with
zero-downtime rollovers.

## Task coverage

| Requirement | Where |
|---|---|
| Web server proxying a public text API | `server.js` — Express proxy for GitHub REST API |
| Dockerized app | `Containerfile` |
| MongoDB via Docker | `compose.yml` (`mongodb` service, named volume) |
| App ↔ DB connection via env vars | `MONGO_HOST/PORT/DATABASE`, `DB_USERNAME/PASSWORD` (see [Environment variables](#environment-variables)) |
| Docker Compose runs the stack | `compose.yml` |
| Kubernetes + Kustomize (dev/staging/prod) | `k8s/base` + `k8s/overlays/{dev,staging,production}` |
| Layered config (ports, URLs, TTL, replicas, hosts, DB name) | Overlay patches + `configMapGenerator` |
| Ingress + in-cluster Services | `k8s/base/ingress.yaml`, `app-service.yaml`, `mongodb-service.yaml` (headless), `mongodb-client-service.yaml` (ClusterIP, what the app/rotator connect through) — `dev` swaps the Ingress for a NodePort Service, see [Ingress vs. NodePort in `dev`](#ingress-vs-nodeport-in-dev) |
| Secret for exposed API (GitHub token) | `github-api-credentials-secret.yaml` → env in `app-deployment.yaml` |
| Secret for DB credentials, mounted in pods | `database-credentials-secret.yaml` → env in `app-deployment.yaml` and MongoDB init |
| CronJob rotating credentials every minute, zero-downtime | `rotator-cronjob.yaml` (rotation script is inline) + `rotator-rbac.yaml` (details in [k8s/README.md](k8s/README.md)) |

## Run with Docker Compose

```sh
cp .env.example .env      # fill in GITHUB_TOKEN if desired
docker compose up --build
curl http://localhost:3000/github/users/torvalds
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `MONGO_HOST` | `127.0.0.1` | MongoDB host (ignored when `MONGO_URI` is set) |
| `MONGO_PORT` | `27017` | MongoDB port (1–65535; ignored when `MONGO_URI` is set) |
| `MONGO_DATABASE` | `github_proxy` | Database name |
| `DB_USERNAME` / `DB_PASSWORD` | unset | Must both be set or both unset |
| `MONGO_URI` | constructed | Overrides individual Mongo vars |
| `CACHE_TTL_SECONDS` | `300` | Cache lifetime for 200 responses |
| `GITHUB_TOKEN` | unset | Bearer token forwarded to GitHub; omit for unauthenticated access |

## Run on Kubernetes

```sh
docker build -f Containerfile -t github-api-proxy:dev .
# edit k8s/overlays/dev/secrets-patch.yaml — replace every replace-with-* value
kubectl apply -k k8s/overlays/dev
kubectl -n github-api-proxy-dev create job --from=cronjob/credentials-rotator bootstrap
```

Overlays differ in namespace, image tag, replica count, host, cache TTL,
storage size, and Secret values. See [k8s/README.md](k8s/README.md) for the
full workflow and the credential-rotation design.

### Ingress vs. NodePort in `dev`

`k8s/base/ingress.yaml` defines an Ingress for the proxy Service, and
`staging`/`production` keep it as-is. The `dev` overlay deletes that Ingress
(`ingress-delete-patch.yaml`) and instead exposes the proxy directly via a
`NodePort` Service on port `30300` (`service-patch.yaml`). This is a deliberate
tradeoff for local minikube use, not an oversight:

- **NodePort in dev (current choice):** no ingress controller, DNS, or TLS
  setup needed — `minikube ip`+`:30300` is reachable immediately after
  `kubectl apply -k k8s/overlays/dev`. The cost is that dev doesn't exercise
  the same Ingress path (host routing, TLS termination, cert-manager) that
  staging/production use, so an Ingress-specific misconfiguration wouldn't be
  caught until staging.
- **Ingress in dev (alternative):** would exercise the same code path as
  staging/production (via `minikube addons enable ingress`), at the cost of
  extra one-time cluster setup and an Ingress host/DNS entry to manage
  locally for what is otherwise a throwaway dev cluster.

Given `dev` is meant for a quick, disposable local loop, NodePort was kept and
the Ingress path is left to be validated in `staging`.

## Zero-downtime credential rotation (summary)

Every minute the `credentials-rotator` CronJob:

1. An `initContainer` generates a new random password and runs
   `db.changeUserPassword()` against the existing `github-proxy` MongoDB user,
   authenticating as root via the `mongodb-root-credentials` Secret.
2. The main container patches that same password into the
   `database-credentials` Secret via `kubectl patch secret`.
3. `stakater/Reloader` detects the Secret change and rolling-restarts the
   proxy Deployment (`maxUnavailable: 0`), so no capacity is lost while pods
   pick up the new password.

MongoDB's password is changed *before* the Secret is patched, so the Secret
always reflects a password MongoDB already accepts. The rotator only ever
rotates the single `github-proxy` app user — there is no versioned-user
scheme. `mongodb-root-credentials` (MongoDB root) and `mongodb-keyfile`
(replica-set internal auth) are separate, unrotated Secrets.

## Endpoints

- `GET /` — health/usage hint.
- `GET /github/<path>` — proxied to `https://api.github.com/<path>`; 200 responses cached in MongoDB with a TTL index; `X-Cache: HIT|MISS` header added.
- Any other method — `405 Method Not Allowed`.

## Repo layout

```
server.js              # the entire app
Containerfile          # image build
compose.yml            # local stack (app + MongoDB)
k8s/base/              # Deployments, Services, Ingress, rotator CronJob + RBAC
k8s/overlays/{dev,staging,production}/  # per-env patches
k8s/README.md          # Kubernetes deploy + rotation details
```
