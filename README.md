# kubeport

**English** | [한국어](README.ko.md)

> Template-driven self-service portal for Kubernetes.
> Admins publish YAML + ui-spec templates; non-experts deploy and operate via abstracted forms.

**Status:** Plans 1 and 2 shipped. Admins can build templates in a UI editor, own them via teams, deprecate versions; users deploy, see status, and never see deprecated templates in the catalog. Plan 3 (User observability) is not written yet.

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
- **Backend**: Go 1.22, Gin, `client-go`, `sqlc`, `atlas`, `coreos/go-oidc`.
- **Data**: PostgreSQL 16 in prod (SQLite for dev); OIDC + httpOnly cookie session, refresh tokens encrypted at rest.
- **Security model**: the app is a UX layer. Every k8s write is performed with the signed-in user's OIDC id_token, so Kubernetes RBAC decides what actually happens.

Full details: [docs/superpowers/specs/2026-04-16-initial-design.md](docs/superpowers/specs/2026-04-16-initial-design.md).

## Quick start

```bash
# 1. Boot local Postgres + dex (OIDC)
docker compose -f deploy/docker/docker-compose.yml up -d

# 2. Apply DB schema (atlas.hcl lives under backend/migrations)
cd backend/migrations && atlas schema apply --env local --auto-approve && cd ..

# 3. Run the Go API
go run ./cmd/server

# 4. Run the web app (another terminal)
cd ../frontend
cp .env.example .env.local   # fill in OIDC + DB values
pnpm install && pnpm dev

# 5. Open http://localhost:3000 and log in as alice / alice
```

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
- Go 1.22+
- Node 20+, pnpm 9+
- [`atlas`](https://atlasgo.io) CLI (DB migrations), `sqlc`
- (e2e only) a kind cluster and `kubectl`

## Roadmap

Work is split into three plans that each ship usable software:

| # | Plan | Ships | Link |
|---|------|-------|------|
| 1 | **Vertical slice** | OIDC login, YAML-mode template CRUD, deploy form, release list & overview | [plan](docs/superpowers/plans/2026-04-16-mvp-1-vertical-slice.md) ✅ |
| 2 | **Admin UX** | UI-mode editor (tree + meta + live preview), publish/deprecate, version history, teams | [plan](docs/superpowers/plans/2026-04-18-mvp-2-admin-ux.md) ✅ |
| 3 | **User observability** | Release logs (SSE), events, settings tabs, update-available migration, Helm chart for self-hosting | *(not written yet)* |

Deferred beyond the MVP: CRD support, Git-backed templates, team/RBAC UI, Helm chart import, release history.

## Repository layout

```
kubeport/
├── backend/                          # Go API (Plan 1)
├── frontend/                         # Next.js (Plan 1)
├── deploy/docker/                    # local compose (Plan 1)
├── deploy/helm/                      # Helm chart (Plan 3)
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

## Contributing

Not yet open to outside contributions — the shape of the system is still stabilizing. Issues and PRs will be welcome once Plan 3 is scoped and merged.

## License

[MIT License](LICENSE) — free to use, modify, and redistribute, provided the copyright notice and license text are preserved.
