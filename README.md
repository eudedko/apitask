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
| Ingress + in-cluster Services | `k8s/base/ingress.yaml`, `app-service.yaml`, `mongodb-service.yaml`, `mongodb-network-policy.yaml` |
| Secret for exposed API (GitHub token) | `github-api-credentials-secret.yaml` → env in `app-deployment.yaml` |
| Secret for DB credentials, mounted in pods | `database-credentials-secret.yaml` → env in `app-deployment.yaml` and MongoDB init |
| CronJob rotating credentials every minute, zero-downtime | `rotator-cronjob.yaml` + `rotator-script-configmap.yaml` + `rotator-rbac.yaml` (details in [k8s/README.md](k8s/README.md)) |

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

## Zero-downtime credential rotation (summary)

Every minute the `credentials-rotator` CronJob:

1. Creates a new versioned MongoDB user `github-proxy-vN` (`readWrite` on the app DB).
2. Patches the `database-credentials` Secret with the new username/password.
3. Triggers a rolling restart of the proxy Deployment.
4. Drops the user from two cycles ago — so old and new pods both have a valid user during the rollout.

The rotator itself uses a **separate**, unrotated `rotator-mongodb-credentials`
Secret (MongoDB root) which also seeds `MONGO_INITDB_ROOT_*` on first boot.

## Endpoints

- `GET /` — health/usage hint.
- `GET /github/<path>` — proxied to `https://api.github.com/<path>`; 200 responses cached in MongoDB with a TTL index; `X-Cache: HIT|MISS` header added.
- Any other method — `405 Method Not Allowed`.

## Repo layout

```
server.js              # the entire app
Containerfile          # image build
compose.yml            # local stack (app + MongoDB)
k8s/base/              # Deployments, Services, Ingress, NetworkPolicy, rotator CronJob + RBAC
k8s/overlays/{dev,staging,production}/  # per-env patches
k8s/README.md          # Kubernetes deploy + rotation details
```
