# kubeport

**English** | [한국어](README.ko.md)

> Template-driven self-service portal for Kubernetes.
> Admins publish YAML + ui-spec templates; non-experts deploy and operate via abstracted forms.

**Status:** Live at <https://kubeport.enzo.kr> (OCI Always Free A1), including a public demo mode you can click through without an account. Shipped and in production: the admin template editor, catalog, RBAC-aware deploy forms, release detail with live logs, DB↔cluster drift cleanup, and a single Helm chart that installs the whole stack. See [CLAUDE.md](CLAUDE.md) for the plan-by-plan table and what is still deferred.

---

## Try the demo and share feedback

**[Open the demo](https://kubeport.enzo.kr) · [Leave feedback](https://github.com/shyuni4u/kubeport/issues/new) · [Browse existing issues](https://github.com/shyuni4u/kubeport/issues)**

We're looking for early feedback: what you tried to do, where you got stuck, and what would make kubeport easier to use. You don't need Kubernetes expertise or a bug report to contribute; confusing wording and missing guidance are useful feedback too. English and Korean are both welcome.

### Demo access vs. personal sign-in

| | Demo access | Personal sign-in |
| --- | --- | --- |
| Account | Shared demo credentials shown on the landing page | Your account with the installation's OIDC provider; Google on the public site |
| Purpose | Explore user/admin screens and a limited deployment flow | Perform actions permitted to your account on that installation |
| Permissions | Demo namespace and feature restrictions apply, including when trying the admin role | Determined by kubeport admin/team permissions and the target cluster's Kubernetes RBAC |
| Data | Shared with other visitors and reset daily. Never enter real passwords, API keys, or personal information | Personal account DB records are outside the demo cleanup scope, but resources in the demo namespace are reset regardless of account. Other retention follows the installation's policy |

**Signing in with Google does not automatically create a private cluster or grant admin access.** Demo access and personal sign-in are different login paths on the same installation; the buttons do not imply separate servers or databases. To use kubeport on your own infrastructure, follow [Install on your cluster](#install-on-your-cluster) and configure authentication, team access, and cluster permissions.

**With demo disabled (`demo.enabled=false`), the chart creates no demo reset job.** When demo is enabled, the reset removes demo-owned database data and deletes workloads, Secrets, PVCs, and other selected resources throughout the demo namespace, regardless of who created them. Resources deployed there with a personal account are also reset; keep real workloads and data in a separate namespace.

The scheduled demo reset cleans up trial data. It does not replace identity or authorization checks.

### A short walkthrough

1. Open the demo and choose the user experience. Use the demo account and password shown on the landing page; no personal account registration is needed.
2. Find **`web-app`** in the catalog and open its deployment form. Are the settings and next steps understandable?
3. Optionally deploy it to the **`demo`** namespace, then inspect its status and logs. Delete only the release you created when you're done.
4. Tell us where you hesitated, what you expected, or what failed—even if you stopped before deploying.

The public demo uses a shared environment and resets daily at **06:00 KST (21:00 UTC)**. It supports real deployments within demo permissions, but restricts administrative actions such as publishing template versions, managing teams, and registering clusters. Try the user flow first; the demo cannot validate every self-hosted workflow.

### What to include in an issue

Check existing issues first; add your experience to a matching issue or open a new one. A short report is enough—copy these prompts into the issue body:

```text
Environment: public demo / self-hosted
What I was trying to do:
Where I got stuck (screen and steps):
What I expected / what actually happened:
When it happened (include timezone):
Version or commit, if known:
Browser / device (optional):
Screenshot (optional, with sensitive information removed):
```

**Issues are public.** Do not include tokens, passwords, Secrets, kubeconfig files, sensitive input values, or unredacted logs. If GitHub is inconvenient, send feedback to the person who invited you; they can help turn it into an issue.

Our initial feedback cycle (roadmap step 14) starts with roughly two weeks of direct user feedback and GitHub Issues. We'll review reports weekly, prioritize recurring problems and blocked tasks, and link fixes and verification results back to the issues. Sentry and Umami integration are deferred until this feedback clarifies what automated collection would help.

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

A few rules hold for every template, and the API refuses one that breaks them:

- **Name** — an RFC 1123 hostname that is also a Kubernetes label value: letters and digits, with `-` or `.` only between them, 63 characters at most. It becomes the `kubeport.io/template` label on everything a release creates. Templates created before this rule are not renamed or refused again — though a name that breaks it was already failing on deploy, so recreate such a template under a valid name.
- **At most 50 objects** in `resources.yaml`, checked on save and again on deploy, so a release's apply fits in the time it holds its namespace lock.
- **One release per namespace, unless the ui-spec says `instances: multiple`.** Then every object is named `<release>-<name>`, the template's own references follow the new names, and selectors also match the release, so the same template can run twice side by side. Object names stay at 30 characters or fewer, `metadata.name` cannot be exposed, and once a version is published the mode belongs to the template.
- **Deleting a release deletes the storage its StatefulSets claimed.** A StatefulSet with `volumeClaimTemplates` is rendered with `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` unless the template writes `Retain`. A deploy whose StatefulSet would take over claims already in the namespace is refused with 409.

## Architecture at a glance

```
Browser ── Next.js (k8s Pod, BFF) ── Go API (in k8s) ── Target k8s clusters (N)
              │                         │
              ▼                         ▼
          Postgres                  (user OIDC token forwarded as-is;
       (sessions + meta)             k8s RBAC is the final authority)
```

- **Frontend**: Next.js 16 (App Router), Tailwind + shadcn/ui, Monaco for YAML, React Hook Form + Zod for dynamic forms. Shipped as a k8s `Deployment` alongside the Go API in the same Helm chart — one `helm install` boots the whole stack.
- **Backend**: Go 1.26+, Gin, `client-go`, `sqlc`, `atlas`, `coreos/go-oidc`.
- **Data**: PostgreSQL 16 (local development runs it in docker compose); OIDC + httpOnly cookie session, refresh tokens encrypted at rest.
- **Security model**: the app is a UX layer. Every k8s write is performed with the signed-in user's OIDC id_token, so Kubernetes RBAC decides what actually happens.

Decisions and the reasons behind them: [docs/brainstorming-summary.md](docs/brainstorming-summary.md). The four screens: [frontend design spec](docs/superpowers/specs/2026-04-19-frontend-design-spec.md).

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

Those `--set` secrets land in your shell history and in `ps`. For an install you
intend to keep, pass them from files instead: [Keeping secrets off the command
line](deploy/helm/kubeport/README.md#keeping-secrets-off-the-command-line).

Set `ingress.className` to your cluster's class — GKE `gce`, EKS `alb`,
nginx-ingress `nginx`, k3s `traefik`. The chart's default is `traefik`. On a
cluster without Traefik that default fails the install with
`no matches for kind "Middleware"` — the chart's http→https redirect is a
Traefik object (#268) — and if you also turned TLS off, nothing errors at all:
the Ingress is created, no controller picks it up, and the address stays empty.
Either way the fix is the class, not the CRD.

On ingress-nginx, also pass
`--set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/proxy-body-size=4m'`
(the single quotes keep the backslashes from the shell, so Helm reads the dots as
part of one annotation name).
kubeport accepts request bodies up to 4 MiB, but nginx's default limit is 1m, so
without it any template or request between 1 and 4 MiB is refused by nginx with
an HTML 413 before kubeport sees it. Traefik (k3s) has no default limit.

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
# Unit + integration (compose must be up — the tests use its Postgres and dex)
(cd backend && go test -p 1 ./...)
# -p 1: packages clean the shared test database by name and would delete each
# other's rows in parallel. `make test` runs the same without it.

# Backend end-to-end happy path (requires a kind cluster — see docs/local-e2e.md)
export KBP_KIND_API=https://127.0.0.1:6443
make e2e
```

Browser end-to-end (Playwright against compose + kind) has its own scripts:
[docs/local-e2e.md §0](docs/local-e2e.md). Layers, prerequisites and per-session
test databases: [docs/testing.md](docs/testing.md).

## Prerequisites

- Docker (for local Postgres + dex)
- Go 1.26+
- Node 20.9+ (Next 16's engines floor; CI and the image run 24), pnpm 10+
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

## Status and roadmap

What each plan shipped, and what is still deferred, is tracked in the plan table
in [CLAUDE.md](CLAUDE.md); open work is in the issue tracker. Deferred for now:
CRD support, Git-backed templates, Helm chart import, release history, and a
background reconciler that watches clusters for drift (today drift is detected
when a release is read).

## Repository layout

```
kubeport/
├── backend/                          # Go API
├── frontend/                         # Next.js BFF + UI
├── deploy/docker/                    # local compose (Postgres + dex)
├── deploy/helm/                      # Helm chart (production install)
├── deploy/oci/                       # bootstrap + deploy scripts for the live install
├── scripts/                          # local e2e, compose and test-DB helpers
├── docs/
│   ├── superpowers/specs/            # design specs still in use
│   ├── decisions/                    # ADRs (added as needs arise)
│   ├── oci-prod-runbook.md           # operating the live install
│   └── brainstorming-summary.md      # why-behind-every-decision
├── CLAUDE.md                         # session entry point for Claude Code
└── README.md
```

## How to find context fast

- **I want to explore the UI direction** → [Mint workspace design lab](docs/design-direction.md) and [admin/user flow review](docs/user-flow-review.md).
- **I want to build something** → read [CLAUDE.md](CLAUDE.md), then the open issues.
- **I want to understand a decision** → [docs/brainstorming-summary.md](docs/brainstorming-summary.md).
- **I want the full system picture** → the stack and architecture boundaries in [CLAUDE.md](CLAUDE.md), and the [frontend design spec](docs/superpowers/specs/2026-04-19-frontend-design-spec.md).
- **I want to run things locally** → "Quick start" above.
- **I want an AI agent to use my installation (Beta)** → install the [kubeport skill](skills/kubeport/SKILL.md), then run its bundled Node.js helper: `node skills/kubeport/scripts/kubeport.mjs login --url https://your-kubeport.example`. Sign in at your installation's `/cli` page and paste the connection token into the terminal's hidden prompt. No MCP service or central authentication is needed. See the [connection reference](skills/kubeport/references/connection.md) for permissions, lifetime and revocation, or the [Korean guide](docs/ai-client.md).
- **I want to call the API from a script** → [backend/api/openapi.yaml](backend/api/openapi.yaml) for the contract, [docs/machine-clients.md](docs/machine-clients.md) for how to authenticate.

## Contributing

Not yet open to outside contributions — the shape of the system is still stabilizing. Bug reports via Issues are welcome now.

## License

[MIT License](LICENSE) — free to use, modify, and redistribute, provided the copyright notice and license text are preserved.

Cluster connections, permissions, node operations, storage and Ingress workflows: [operations guide](docs/cluster-operations.md).
