# kubeport Helm chart

Single chart that deploys backend (Go API), frontend (Next.js BFF), an
optional in-cluster Postgres, an Ingress, an optional cert-manager
Certificate, and an `atlas schema apply` initContainer that runs ahead of
the backend container on every Pod start.

Target environments — k3s (Phase 1/2/3 per [ADR 0003](../../decisions/0003-hosting-oci-always-free.md))
and any conformant Kubernetes cluster with cert-manager + an Ingress
controller. Cloud-neutrality is by design: only `ingress.className`,
`postgres.storageClassName`, the public host, and the OIDC issuer URL
should differ between environments.

## Quick install (Phase 1 — GCP bootstrap)

```bash
# 1. Generate secrets locally — never commit them
ENC_KEY=$(openssl rand -base64 32)
PG_PASS=$(openssl rand -hex 24)

# 2. Pre-install cert-manager + a ClusterIssuer (one-time per cluster)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.1/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=120s deploy -n cert-manager --all

cat <<'YAML' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    email: you@example.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: traefik
YAML

# 3. Install the chart
helm install kubeport deploy/helm/kubeport \
  -f deploy/helm/kubeport/values-gcp-phase1.yaml \
  --namespace kubeport --create-namespace \
  --set host=demo.kubeport.example \
  --set oidc.clientId=$GOOGLE_OAUTH_CLIENT_ID \
  --set auth.appEncryptionKeyB64=$ENC_KEY \
  --set auth.oidcClientSecret=$GOOGLE_OAUTH_CLIENT_SECRET \
  --set postgres.password=$PG_PASS
```

## Upgrade

```bash
helm upgrade kubeport deploy/helm/kubeport \
  -f deploy/helm/kubeport/values-gcp-phase1.yaml \
  --namespace kubeport \
  --reuse-values \
  --set images.backend.tag=$NEW_SHA \
  --set images.frontend.tag=$NEW_SHA
```

`--reuse-values` keeps the secrets you passed at install time. The
backend Pod's `migrate` initContainer runs `atlas schema apply` before the
backend container starts; if migration fails the new Pod never reaches Ready
and rolling upgrade pauses, so old Pods stay live serving traffic.

The frontend Pod has its own `wait-for-backend` initContainer (polls backend
`/healthz`) so it doesn't open DB connections against an un-migrated schema.

## Uninstall

```bash
helm uninstall kubeport --namespace kubeport
# PVCs are NOT deleted by helm uninstall — clean them up manually if you
# want to discard data:
kubectl --namespace kubeport delete pvc -l app.kubernetes.io/instance=kubeport
```

## Values matrix

### Secret modes

| Mode | Set | Where |
|---|---|---|
| Chart-managed (dev / Phase 1) | `auth.create=true`, plus `auth.appEncryptionKeyB64` / `auth.oidcClientSecret` / `postgres.password` via `--set` | Chart writes a `<release>-auth` Secret with `DATABASE_URL`, `APP_ENCRYPTION_KEY_B64`, `OIDC_CLIENT_SECRET` |
| External (recommended for prod) | `auth.create=false`, `auth.existingSecret=<name>` | You provide a Secret named `<name>` containing the same three keys; e.g. via `sealed-secrets` or `external-secrets` |

### Postgres modes

| Mode | Set | Notes |
|---|---|---|
| Embedded (single-node demo) | `postgres.embedded=true` (default) | StatefulSet + headless Service + PVC. Backups not handled by chart — see ADR 0003 §"Phase 2" |
| External | `postgres.embedded=false`, `postgres.externalUrl=postgres://...` | Use a managed PG (Cloud SQL, RDS) for prod. `externalUrl` is read at chart-render time and baked into the auth Secret unless `auth.create=false` (in which case provide it in your external Secret) |

### Cloud-specific values (Ingress + StorageClass)

| Cluster | `ingress.className` | `postgres.storage.storageClassName` |
|---|---|---|
| k3s (Phase 1/2/3) | `traefik` | `local-path` |
| GKE | `gce` | `standard-rwo` |
| EKS | `alb` (with [ALB controller](https://github.com/kubernetes-sigs/aws-load-balancer-controller)) | `gp3` |
| AKS | `azure-application-gateway` | `default` |
| nginx-ingress (any) | `nginx` | varies |
| kind / minikube (CI smoke) | `nginx` (or disable) | `standard` |

## Schema sync

The chart embeds a copy of `backend/migrations/schema.hcl` at
`deploy/helm/kubeport/files/schema.hcl`. They MUST stay in sync — the CI
workflow `.github/workflows/helm.yml` fails if they diverge.

After editing the source schema:

```bash
make helm-sync
```

Then run `make helm-snapshot-update` to refresh the golden snapshot used
by CI:

```bash
make helm-snapshot-update
git add backend/migrations/schema.hcl deploy/helm/kubeport/files/schema.hcl deploy/helm/kubeport/ci/snapshot.yaml
git commit -m "..."
```

`make helm-snapshot` (without `-update`) only diffs against the existing
snapshot — that's what CI runs; non-zero exit signals an unintended
template change.

## Demo mode (Dex)

Optional self-hosted [Dex](https://dexidp.io/) IdP for a public demo login,
in addition to the primary `oidc.*` IdP (e.g. Google). The backend accepts
tokens from both issuers via `KBP_OIDC_ISSUERS`.

Enable with:

```yaml
dex:
  enabled: true
  host: dex.example.com          # required — needs its own DNS A record
  clientSecret: <random>          # --set dex.clientSecret=$(openssl rand -hex 24)
  staticPasswords:
    - email: demo-admin@demo.kubeport
      username: demo-admin
      userID: demo-admin-000
      hash: <bcrypt hash>
    - email: demo-user@demo.kubeport
      username: demo-user
      userID: demo-user-000
      hash: <bcrypt hash>

demo:
  enabled: true
  adminPassword: <random>         # --set; used by the reset CronJob only
  userPassword: <random>          # --set
  passwordHint: ""                # shown on the landing page — public by design
```

Generate a static-password bcrypt hash:

```bash
htpasswd -bnBC 10 "" '<password>' | tr -d ':\n'
```

`demo.enabled=true` also creates:

- A `demo` namespace (name from `demo.namespace`) with a `ResourceQuota`,
  `LimitRange`, and an egress-only `NetworkPolicy` (DNS + outbound, no
  in-cluster lateral traffic, no LoadBalancer Services, no Ingresses).
- `demo-admin`/`demo-user` `Role`s + `RoleBinding`s scoped to that namespace,
  plus a cluster-scoped `ClusterRole`/`ClusterRoleBinding` granting
  `selfsubjectaccessreviews` (create) — the RBAC panel needs this even for
  non-admin demo users.
- A `demo-reset` `CronJob` (`demo.resetSchedule`, default every 6 hours) that
  wipes all objects in the demo namespace and re-seeds it via
  `/seed-demo --reset` (shipped in the backend image).

`dex.enabled=true` renders a `ClusterIP` Service + Deployment for Dex, plus
an `Ingress`/`Certificate` on `dex.host` (mirrors the main chart's
`ingress.className` / `tls.certManager.*`).

**k3s must trust the Dex issuer** for the RBAC bindings above to resolve —
see [`deploy/oci/README.md` §7.6](../../oci/README.md#76). `dex.host` needs
its own DNS record pointing at the cluster ingress, separate from the main
`host`.

## Templates

| Template | When rendered |
|---|---|
| `backend-{deployment,service,configmap}.yaml` | always |
| `frontend-{deployment,service,configmap}.yaml` | always |
| `secret.yaml` | `auth.create=true` |
| `dex-{configmap,secret,deployment,service,ingress,certificate}.yaml` | `dex.enabled=true` (certificate also requires `tls.enabled` + `tls.certManager.enabled`) |
| `demo-namespace.yaml`, `demo-rbac.yaml`, `demo-reset-cronjob.yaml` | `demo.enabled=true` |
| `postgres-{statefulset,service,secret}.yaml` | `postgres.embedded=true` |
| `ingress.yaml` | `ingress.enabled=true` |
| `certificate.yaml` | `tls.enabled=true` AND `tls.certManager.enabled=true` |
| `migration-configmap.yaml` (schema.hcl + atlas.hcl) | `migration.enabled=true` (default true) — mounted by the backend Pod's `migrate` initContainer |

## Local validation

```bash
# Render the default values:
helm template kubeport deploy/helm/kubeport \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=local-test \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set auth.oidcClientSecret=test \
  --set postgres.password=test

# Lint with the CI fixture values:
make helm-lint

# Diff against the golden snapshot (this is what CI runs):
make helm-snapshot
```

For a real install on a kind cluster, follow the kind-smoke job in
`.github/workflows/helm.yml` — same flow, same `ci/smoke-values.yaml`.

## See also

- [Plan 9 — Helm chart MVP](../../docs/superpowers/plans/2026-04-29-plan9-helm-chart.md)
- [ADR 0001](../../docs/decisions/0001-frontend-deployment-helm-over-vercel.md) — frontend in same Helm chart as backend
- [ADR 0003](../../docs/decisions/0003-hosting-oci-always-free.md) — 3-Phase hosting decision tree
- [docs/deploy/images.md](../../docs/deploy/images.md) — multi-arch image build pipeline
