# kubeport

**English** | [한국어](README.ko.md)

> Template-driven self-service portal for Kubernetes.
> Admins publish YAML + ui-spec templates; non-experts deploy and operate via abstracted forms.

**Status:** Live at <https://kubeport.enzo.kr> (OCI Always Free A1), including a public demo mode you can click through without an account. Shipped and in production: the admin template editor, catalog, RBAC-aware deploy forms, release detail with live logs, DB↔cluster drift cleanup, and a single Helm chart that installs the whole stack. See [CLAUDE.md](CLAUDE.md) for the plan-by-plan table and what is still deferred.

---

## Why

Running Kubernetes well still requires reading a lot of YAML. Existing tools solve pieces of the problem:

- `k9s` / `Lens` / `Headlamp` are great for operators but assume you know k8s.
- `Rancher` / `OpenShift` template catalogs exist but lean on Helm and still expose resource-level concepts.
- `Backstage Software Templates` handle scaffolding but not day-to-day operation.

`kubeport` fills the intersection: one admin writes a template once; every teammate can deploy and watch it without ever seeing a `Pod`, `Deployment`, or `replicas` field they didn't ask for. Think "Swagger for Kubernetes" — a single spec becomes both the exact manifest that runs in the cluster and the friendly form an end user fills out.

## Core concepts

A **template** is two files (optionally three). Together they live as a single versioned row in the app database.

```
# resources.yaml  — pure Kubernetes YAML, no placeholders
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25

# ui-spec.yaml  — which JSON paths to expose to end users
fields:
  - path: Deployment[web].spec.replicas
    label: "인스턴스 개수"
    type: integer
    min: 1
    max: 20
    default: 3
  - path: Deployment[web].spec.template.spec.containers[0].image
    label: "컨테이너 이미지"
    type: string
```

A `path` segment must look like a Go identifier. Kubernetes keys that do not — labels, annotations, ConfigMap data filenames — go in quotes, which makes them one key despite the dots: `Deployment[web].metadata.labels["app.kubernetes.io/name"]`. The UI-mode editor adds the quotes for you; hand-written ui-spec YAML needs them.

End users see a form with two fields (plus a release name). Everything else in `resources.yaml` is fixed by the admin.

A **release** is one deployment of a template version into a specific cluster + namespace. Releases are pinned to a template version (Helm/ArgoCD-style). When the admin publishes a new version, running releases keep working and get an "update available" nudge.

## Architecture at a glance

```
Browser ── Next.js (k8s Pod, BFF) ── Go API (in k8s) ── Target k8s clusters (N)
              │                         │
              ▼                         ▼
          Postgres                  (user OIDC token forwarded as-is;
       (sessions + meta)             k8s RBAC is the final authority)
```

- **Frontend**: Next.js 15 (App Router), Tailwind + shadcn/ui, Monaco for YAML, React Hook Form + Zod for dynamic forms. Shipped as a k8s `Deployment` alongside the Go API in the same Helm chart — one `helm install` boots the whole stack.
- **Backend**: Go 1.26+, Gin, `client-go`, `sqlc`, `atlas`, `coreos/go-oidc`.
- **Data**: PostgreSQL 16 in prod (SQLite for dev); OIDC + httpOnly cookie session, refresh tokens encrypted at rest.
- **Security model**: the app is a UX layer. Every k8s write is performed with the signed-in user's OIDC id_token, so Kubernetes RBAC decides what actually happens.

Full details: [docs/superpowers/specs/2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md).

## Install on your cluster

Self-hosting is a single Helm chart:

```bash
git clone https://github.com/shyuni4u/kubeport && cd kubeport
helm install kubeport deploy/helm/kubeport --namespace kubeport --create-namespace \
  --set host=kubeport.example.com \
  --set ingress.className=nginx \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=$CLIENT_ID --set oidc.audience=$CLIENT_ID \
  --set-string auth.devAdminEmails=you@example.com \
  --set auth.oidcClientSecret=$CLIENT_SECRET \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set postgres.password=$(openssl rand -hex 24)
```

Set `ingress.className` to your cluster's class — GKE `gce`, EKS `alb`,
nginx-ingress `nginx`, k3s `traefik`. The chart's default is `traefik`, and on a
cluster without it the Ingress is created and then simply never picked up by any
controller. Nothing errors; the address stays empty.

That command also installs the `latest` tag. For an install you intend to keep,
add `--set images.backend.tag=sha-<7> --set images.frontend.tag=sha-<7>` — every
main commit publishes one, and pinning is what makes a rollback possible.

TLS comes from cert-manager. The chart creates a `Certificate` that points at a
**ClusterIssuer named `letsencrypt-prod`**, but it does not create that issuer.
If the cluster has no issuer by that name, `helm install` still succeeds and
every Pod goes Ready — the certificate simply never issues, and the site has no
valid TLS. The only sign is `READY False` in `kubectl -n kubeport get certificate`.
So before installing, create that ClusterIssuer (step 2 of the chart README's
[Quick install](deploy/helm/kubeport/README.md#quick-install-any-cluster) has
one — change its solver's `class: traefik` to your `ingress.className`, or the
HTTP-01 challenge goes unanswered and fails the same silent way), or point the
chart at what you have:

- another ClusterIssuer: `--set tls.certManager.issuerName=<name>`
- a TLS Secret you already have: `--set tls.certManager.enabled=false --set tls.existingSecret=<secret>`
- no TLS inside the cluster: `--set tls.enabled=false --set tls.certManager.enabled=false`.
  The login and logout URLs the chart derives then become `http://`. If TLS is
  terminated in front of the cluster (a load balancer, Cloudflare), give the
  chart the `https://` address browsers see:
  `--set oidc.redirectUri=https://<host>/api/auth/callback`. It must match the
  redirect URI registered with the IdP, or the IdP refuses the login; and when
  `frontend.publicOrigins` is empty, its origin is also the one logout checks,
  so an `http://` one gets logout refused with 403.

Read [deploy/helm/kubeport/README.md](deploy/helm/kubeport/README.md) first —
especially **"After install — required on every cluster"**. Without those steps
the app runs and people can log in, but it cannot deploy anything.

The "Quick start" below is for local development only.

## Quick start

```bash
# Once per machine, before step 0: dex's issuer URL is the literal name
# host.docker.internal, so that name has to resolve to 127.0.0.1 on this host.
# Docker Desktop often pre-seeds it with the machine's LAN IP instead, which
# still resolves — and still fails, because dex is not listening there.
grep -i host.docker.internal /etc/hosts    # Windows: C:\Windows\System32\drivers\etc\hosts
# Want exactly: 127.0.0.1 host.docker.internal
# Delete any other address for that name. Full procedure: docs/local-e2e.md §1

# 0. Generate the cert dex serves TLS with. Once per clone — the files are
#    gitignored, so a fresh clone has none and dex exits with
#    "open /config/certs/dex.crt: no such file or directory".
#    (k8s 1.30+ rejects http:// OIDC issuers, so dex runs over TLS even locally.)
cd deploy/docker/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout dex.key -out dex.crt -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1"
chmod 644 dex.key      # the dex container reads it as a non-root user, so 600 will
                       # not start. World-readable is deliberate and safe only
                       # because this is a throwaway pair: step 3 below trusts
                       # dex.crt as a CA, so on a shared machine anyone who can
                       # read this key can impersonate your local IdP. Never
                       # reuse the pair outside this compose stack.
cd -
# On Windows Git Bash, prefix that openssl line with MSYS_NO_PATHCONV=1 — MSYS
# rewrites the leading slash of -subj into a filesystem path and openssl then
# rejects it ("This name is not in that format: 'C:/Program Files/Git/CN=...'").

# 1. Boot local Postgres + dex (OIDC)
docker compose -f deploy/docker/docker-compose.yml up -d
docker compose -f deploy/docker/docker-compose.yml ps    # both must be Up (healthy)

# 2. Apply DB schema (atlas.hcl lives under backend/migrations)
cd backend/migrations && atlas schema apply --env local --auto-approve && cd ..

# 3. Run the Go API. It needs env — with none it exits immediately on
#    "OIDC config: set KBP_OIDC_ISSUERS or both OIDC_ISSUER and OIDC_AUDIENCE".
#    Full set and what each knob does: docs/local-e2e.md §7.
LISTEN_ADDR=:8080 \
  DATABASE_URL='postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable' \
  OIDC_ISSUER=https://host.docker.internal:5556 \
  OIDC_AUDIENCE=kubeport \
  OIDC_CA_FILE="$PWD/../deploy/docker/certs/dex.crt" \
  APP_ENCRYPTION_KEY_B64="$KBP_KEY" \
  KBP_DEV_ADMIN_EMAILS=admin@example.com \
  go run ./cmd/server
# $KBP_KEY: generate it once with `export KBP_KEY=$(openssl rand -base64 32)` and
# use the same value in step 4. The frontend encrypts session tokens with this key
# and the backend is configured with it; two different values means every login is
# written by one and unreadable by the other.
# ^ dev only: grants in-app admin by email address, with no group check at all.
#   The same variable behaves identically in production. Never set it there.
#
# "discovery failed ... (will retry on first use)" at startup is fine if dex was
# merely slow to come up, and permanent if the hosts entry above is wrong. Do not
# read /healthz as an answer — it returns 200 either way, because it checks the
# DB and the listener, not the IdP. Ask dex directly:
#   curl -ks -o /dev/null -w '%{http_code}\n' \
#     https://host.docker.internal:5556/.well-known/openid-configuration
# 200 = good. 000 = the name resolves somewhere dex is not, and login cannot
# work no matter what the backend logs say.

# 4. Run the web app (another terminal). frontend/.env.local is gitignored and
#    there is no example file to copy, so write it. Full block with every knob
#    explained: docs/local-e2e.md §8. Minimum for this quick start:
cd ../frontend
cat > .env.local <<EOF
GO_API_BASE_URL=http://localhost:8080
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=$KBP_KEY
OIDC_ISSUER=https://host.docker.internal:5556
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
EOF
pnpm install
# NODE_EXTRA_CA_CERTS is not optional: openid-client has to trust the self-signed
# dex cert from step 0, and without it the login callback fails on certificate
# verification rather than anything that names the cause.
NODE_EXTRA_CA_CERTS="$PWD/../deploy/docker/certs/dex.crt" pnpm dev

# 5. Open http://localhost:3000 and log in as alice / alice
```

`scripts/e2e/up.sh` writes that `.env.local` for you, but it also builds a kind
cluster and issues certs — that is the e2e path, not this one. Use it when you
want the whole stack ([docs/local-e2e.md §0](docs/local-e2e.md)), not to shortcut
step 4.

For a full browser → deploy-to-kind walkthrough — self-signed dex cert, Windows hosts gotchas, the whole OIDC story — see [docs/local-e2e.md](docs/local-e2e.md). The quick start above is enough for backend + frontend + DB; e2e against a real k8s cluster needs a few more knobs.

## Running tests

```bash
# Unit + integration (compose must be up; see backend/CLAUDE.md)
make test                      # equivalent: cd backend && go test ./...

# End-to-end happy path (requires a kind cluster — see docs/local-e2e.md)
export KBP_KIND_API=https://127.0.0.1:6443
make e2e
```

## Prerequisites

- Docker (for local Postgres + dex)
- Go 1.26+
- Node 20+, pnpm 10+
- [`atlas`](https://atlasgo.io) CLI (DB migrations), `sqlc`
- `openssl` (the dex cert in step 0; also generates the install secrets above)
- (install only) [`helm`](https://helm.sh) 3.x — pin **v3.20.2** if you will
  regenerate the chart snapshot, which is the version CI runs. Helm 4 renders an
  extra blank line before each document separator, so a snapshot refreshed with
  it fails CI on a diff you did not make.
- `kubectl` — every install needs it, not just tests: the chart README's
  "After install" steps and the port-forward below are all kubectl
- (e2e, and the "Try it first" path below) [`kind`](https://kind.sigs.k8s.io) —
  `scripts/e2e/up.sh` drives it and `scripts/e2e/doctor.sh` checks for it
- `make` — `make test`, `make e2e` and the chart's `make helm-snapshot` all use it;
  it is not in a stock Ubuntu/WSL image

"Install on your cluster" additionally needs an Ingress controller and
cert-manager on the target cluster. To try kubeport without either, use the
no-Ingress path in [the chart README](deploy/helm/kubeport/README.md#try-it-first-any-cluster-no-ingress-no-cert-manager).

Setup per OS, and the traps that come with Windows paths, are in
[docs/dev-setup.md](docs/dev-setup.md).

## Roadmap

Work is split into three plans that each ship usable software:

| # | Plan | Ships | Link |
|---|------|-------|------|
| 1 | **Vertical slice** | OIDC login, YAML-mode template CRUD, deploy form, release list & overview | [plan](docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md) ✅ |
| 2 | **Admin UX** | UI-mode editor (tree + meta + live preview), publish/deprecate, version history, teams | [plan](docs/superpowers/plans/2026-04-18-mvp-2-admin-ux.md) ✅ |
| 3 | **User observability** | Release logs (SSE), events, settings tabs, update-available migration, Helm chart for self-hosting | shipped — see [CLAUDE.md](CLAUDE.md) for plans 4-13 ✅ |

Deferred beyond the MVP: CRD support, Git-backed templates, team/RBAC UI, Helm chart import, release history.

## Repository layout

```
kubeport/
├── backend/                          # Go API (Plan 1)
├── frontend/                         # Next.js (Plan 1)
├── deploy/docker/                    # local compose (Plan 1)
├── deploy/helm/                      # Helm chart (production install)
├── docs/
│   ├── superpowers/specs/            # design specs
│   ├── superpowers/plans/            # implementation plans
│   ├── decisions/                    # ADRs (added as needs arise)
│   └── brainstorming-summary.md      # why-behind-every-decision
├── CLAUDE.md                         # session entry point for Claude Code
└── README.md
```

## How to find context fast

- **I want to build something** → read [CLAUDE.md](CLAUDE.md) then the current plan in `docs/superpowers/plans/`.
- **I want to understand a decision** → [docs/brainstorming-summary.md](docs/brainstorming-summary.md).
- **I want the full system picture** → [docs/superpowers/specs/2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md).
- **I want to run things locally** → "Quick start" above.
- **I want to call the API from a script** → [backend/api/openapi.yaml](backend/api/openapi.yaml) for the contract, [docs/machine-clients.md](docs/machine-clients.md) for how to authenticate.

## Contributing

Not yet open to outside contributions — the shape of the system is still stabilizing. Bug reports via Issues are welcome now.

## License

[MIT License](LICENSE) — free to use, modify, and redistribute, provided the copyright notice and license text are preserved.
