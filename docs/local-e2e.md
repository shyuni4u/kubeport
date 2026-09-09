# Local end-to-end setup

## §0. 빠른 시작 — 어느 PC 에서든 (권장 경로)

**원칙: Playwright e2e 는 로컬에서 먼저 돌린다.** CI(`playwright.yml`) 는 백스톱이다 — kind 를 매번 새로 만들어 느리고(≈5분) 가끔 인프라 플레이크가 난다. 스펙을 고치거나 배포 폼·에디터·릴리스 화면을 건드렸으면 푸시 전에 로컬에서 13개 스펙을 통과시킨다.

`scripts/e2e/` 가 §1~§9 를 코드로 옮긴 것이다. 전부 멱등이라 매 세션 그대로 다시 실행하면 된다. Git Bash(Windows)·WSL·macOS·Linux 공통 — `jq` 를 쓰지 않는다(node 로 대체).

```bash
# 한 번 (머신당): docs/dev-setup.md 툴 설치 + §1 hosts 항목 (host.docker.internal → 127.0.0.1)
scripts/e2e/doctor.sh      # 무엇이 빠졌는지 먼저 본다 (읽기 전용)

# 매 세션
scripts/e2e/up.sh          # dex 인증서 · compose(postgres+dex) · atlas 스키마 · frontend/.env.local · kind 클러스터(OIDC 신뢰) · RBAC
scripts/e2e/backend.sh     # 터미널 1 (Go :8080)
scripts/e2e/frontend.sh    # 터미널 2 (Next :3000)
scripts/e2e/seed.sh        # 클러스터 등록(1회) + 데모 시드. 픽스처를 바꿨으면 `seed.sh -reset`
scripts/e2e/run.sh         # = pnpm exec playwright test. 특정 스펙: run.sh tests/e2e/05-user-deploy.spec.ts --headed
```

| 증상 | 원인·조치 |
|---|---|
| `dex not reachable` | hosts 에 `host.docker.internal` 이 없거나 LAN IP 로 잡힘 → §1. Docker Desktop 이 자동으로 넣은 항목은 지우고 `127.0.0.1 host.docker.internal` 로 |
| 로그인 후 `/catalog` 로 안 감, 401 | `frontend/tests/e2e/.auth/*.json` 이 DB 리셋·dex 재시작 이후 stale → `run.sh --fresh` |
| 05 스펙의 pattern 검증이 안 뜸 | 예전 시드 템플릿이 남아 있음 → `seed.sh -reset` |
| 06 스펙 `draft must exist` | 시드가 draft 를 못 만듦(두 번 실행 필요한 케이스) → `seed.sh` 한 번 더 |
| kind 가 `EOF` / 503 | apiserver 재시작 중 → 10초 후 재시도. `kubectl --context kind-kubeport get --raw /readyz` |
| Windows 에서 `jq: command not found` | 스크립트는 jq 를 안 쓴다. §9 의 수동 curl 예시만 jq 를 쓰므로 스크립트를 쓸 것 |
| 템플릿이 `/templates`·`/catalog` 목록에 없거나, 버전 상세가 403 / 404 | 아직 publish 안 된 **초안(draft)** 이다. 초안은 템플릿 소유자에게만 보인다 — 전역 템플릿은 `kubeport-admin`, 팀 템플릿은 그 팀 멤버(editor·viewer 둘 다). `publish` 하거나 해당 계정을 팀에 추가한다 |

아래 §1~§10 은 스크립트가 하는 일의 설명서이자, 스크립트가 실패했을 때의 수동 경로다.

Run the full browser → deploy-to-kind flow on one machine. Use this when you
need to test a change that crosses the dex / Go / Next.js / k8s boundaries —
unit and integration tests won't catch OIDC trust, BFF proxying, or actual pod
scheduling.

For run-of-the-mill coding, `make test` against docker compose is enough. This
doc is the ladder for when you actually need to click around as alice and watch
a pod come up.

## Prereqs (install once per machine)

- Docker Desktop (WSL2 integration on for Windows)
- Go 1.22+, Node 20+, pnpm 9+
- `atlas`, `kind` (`v0.23+`), `kubectl`, `jq`
- `openssl`

See [dev-setup.md](dev-setup.md) for Docker Desktop / WSL2 gotchas. Everything
below assumes your repo lives under `~/dev/kubeport` (WSL2 home), not on
`/mnt/c/`.

## One-time setup

### 1. Fix Windows `hosts` for `host.docker.internal`

Docker Desktop sometimes writes a bad IP into Windows's hosts file (e.g. the
machine's public IP from ISP DNS leak). Open PowerShell as Administrator:

```powershell
notepad C:\Windows\System32\drivers\etc\hosts
```

Find the lines:

```
### # Added by Docker Desktop
<some-wrong-ip> host.docker.internal
<some-wrong-ip> gateway.docker.internal
```

Replace the IPs with `127.0.0.1`. Save. No reboot needed — WSL2's
`host.docker.internal` resolution will then return `127.0.0.1` automatically.

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://host.docker.internal:5556/   # should be 000 (nothing listening yet), NOT timeout
```

### 2. Self-signed dex cert

`k8s 1.30+` rejects `http://` OIDC issuer URLs with "URL scheme must be
https", so dex runs over TLS even locally.

```bash
cd deploy/docker/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout dex.key -out dex.crt \
  -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1"
chmod 644 dex.key        # dex container needs read access
```

Files are gitignored.

### 3. DB schema

```bash
cd backend/migrations
atlas schema apply --env local --auto-approve
```

Only re-run when `schema.hcl` changes.

## Every-session setup

### 4. Start dex + Postgres

```bash
docker compose -f deploy/docker/docker-compose.yml up -d
curl -ks https://host.docker.internal:5556/.well-known/openid-configuration | jq .issuer
# → "https://host.docker.internal:5556"
```

### 5. Create kind cluster with OIDC trust for dex

Save as `/tmp/kind-cluster.yaml` (adjust the `hostPath` to your repo):

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: kubeport
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: /home/<you>/kubeport/deploy/docker/certs/dex.crt
        containerPath: /etc/kubernetes/pki/dex-ca.crt
        readOnly: true
    kubeadmConfigPatches:
      - |
        kind: ClusterConfiguration
        apiServer:
          extraArgs:
            oidc-issuer-url: https://host.docker.internal:5556
            oidc-client-id: kubeport
            oidc-username-claim: email
            oidc-groups-claim: groups
            oidc-ca-file: /etc/kubernetes/pki/dex-ca.crt
    extraPortMappings:
      - containerPort: 6443
        hostPort: 6443
        listenAddress: "127.0.0.1"
```

```bash
kind create cluster --config /tmp/kind-cluster.yaml --wait 2m
```

### 6. RBAC so dex users can do things

```bash
cat <<'YAML' | kubectl --context kind-kubeport apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: kubeport-admin }
subjects:
  - kind: Group
    name: kubeport-admin
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: kubeport-users, namespace: default }
subjects:
  - kind: Group
    name: system:authenticated
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: edit
  apiGroup: rbac.authorization.k8s.io
YAML
```

`kubeport-admin` is aspirational — dex staticPasswords can't emit `groups`
claims (see **Known limits**). The `system:authenticated` binding is what
actually lets alice deploy.

Demo users need their own bindings — the `system:authenticated` binding above
already covers `edit`-level access, but the demo admin needs `admin` to
manage its own seeded resources. kind's OIDC integration trusts the id_token
`email` claim verbatim (no `dex:` username prefix like some managed
clusters), so bind the raw email addresses:

```bash
kubectl create rolebinding demo-admin --clusterrole=admin --user=demo-admin@demo.kubeport -n default
kubectl create rolebinding demo-user  --clusterrole=edit  --user=demo-user@demo.kubeport  -n default
```

### 7. Backend

```bash
cd backend
LISTEN_ADDR=:8080 \
  DATABASE_URL='postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable' \
  OIDC_ISSUER=https://host.docker.internal:5556 \
  OIDC_AUDIENCE=kubeport \
  OIDC_CA_FILE="$(pwd)/../deploy/docker/certs/dex.crt" \
  APP_ENCRYPTION_KEY_B64="$(openssl rand -base64 32)" \
  KBP_DEV_ADMIN_EMAILS=admin@example.com,demo-admin@demo.kubeport \
  KBP_DEMO_EMAIL_DOMAIN=demo.kubeport \
  go run ./cmd/server
```

`KBP_DEV_ADMIN_EMAILS` is how we fake the `kubeport-admin` group locally —
see **Known limits**. Never set in prod.

`KBP_DEMO_EMAIL_DOMAIN` marks any user whose email ends in that domain as a
demo account — the backend then rejects mutating requests outside the
seeded demo scope (`demo-restricted`, see `internal/api/middleware.go`).
Leave unset to disable demo restrictions entirely.

### 8. Frontend

Create `frontend/.env.local`:

```env
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=<same value as backend>
GO_API_BASE_URL=http://localhost:8080

OIDC_ISSUER=https://host.docker.internal:5556
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Demo provider (locally the same dex + client as primary)
DEMO_OIDC_ISSUER=https://host.docker.internal:5556
DEMO_OIDC_CLIENT_ID=kubeport
DEMO_OIDC_CLIENT_SECRET=local-dev-secret
DEMO_EMAIL_DOMAIN=demo.kubeport
DEMO_ADMIN_EMAIL=demo-admin@demo.kubeport
DEMO_USER_EMAIL=demo-user@demo.kubeport
DEMO_PASSWORD_HINT=demo
```

Start with the CA path exported (Next.js openid-client must trust the self-
signed dex cert):

```bash
cd frontend
NODE_EXTRA_CA_CERTS="$(pwd)/../deploy/docker/certs/dex.crt" pnpm dev
```

### 9. Register the cluster + seed a template

```bash
ADM=$(curl -ks -X POST https://host.docker.internal:5556/token \
  -d grant_type=password -d client_id=kubeport -d client_secret=local-dev-secret \
  -d username=admin@example.com -d password=admin \
  -d 'scope=openid email profile groups' | jq -r .id_token)

# Cluster — register with kind's own CA (not dex's; the CA here validates
# the apiserver cert, and kind signs that with its internal cluster CA).
KIND_CA=$(kubectl --context kind-kubeport config view --raw --minify --flatten -o json \
  | jq -r '.clusters[0].cluster."certificate-authority-data"' | base64 -d)

jq -n --arg ca "$KIND_CA" '{
  name:"kind",
  api_url:"https://127.0.0.1:6443",
  ca_bundle:$ca,
  oidc_issuer_url:"https://host.docker.internal:5556"
}' | curl -s -H "Authorization: Bearer $ADM" -H 'content-type: application/json' \
  -X POST http://localhost:8080/v1/clusters -d @-

# Sample template + publish
curl -s -H "Authorization: Bearer $ADM" -H 'content-type: application/json' \
  -X POST http://localhost:8080/v1/templates -d @- <<'JSON'
{
  "name":"web",
  "display_name":"Web Service",
  "authoring_mode":"yaml",
  "resources_yaml":"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.25\n          ports:\n            - containerPort: 80\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector: {app: web}\n  ports: [{port: 80, targetPort: 80}]\n",
  "ui_spec_yaml":"fields:\n  - path: Deployment[web].spec.replicas\n    label: 인스턴스 개수\n    type: integer\n    min: 1\n    max: 5\n    default: 2\n    required: true\n  - path: Deployment[web].spec.template.spec.containers[0].image\n    label: 컨테이너 이미지\n    type: string\n    default: nginx:1.25\n    required: true\n"
}
JSON

curl -s -H "Authorization: Bearer $ADM" -X POST \
  http://localhost:8080/v1/templates/web/versions/1/publish
```

### 9b. Seed demo data

Populates the demo catalog (3 templates, incl. the "웹 앱" / "야간 배치" ones
the e2e demo spec asserts on) and a couple of releases, owned by the two demo
dex users from Step 1 above. Requires the demo RBAC bindings from §6 and the
backend running with `KBP_DEMO_EMAIL_DOMAIN` set (§7).

```bash
cd backend
DEMO_OIDC_ISSUER=https://host.docker.internal:5556 \
  DEMO_OIDC_CLIENT_ID=kubeport \
  DEMO_OIDC_CLIENT_SECRET=local-dev-secret \
  OIDC_CA_FILE="$(pwd)/../deploy/docker/certs/dex.crt" \
  KBP_API_BASE_URL=http://localhost:8080 \
  DEMO_ADMIN_EMAIL=demo-admin@demo.kubeport \
  DEMO_ADMIN_PASSWORD=demo \
  DEMO_USER_EMAIL=demo-user@demo.kubeport \
  DEMO_USER_PASSWORD=demo \
  DEMO_CLUSTER=kind \
  DEMO_NAMESPACE=default \
  KBP_DEMO_EMAIL_DOMAIN=demo.kubeport \
  go run ./cmd/seed-demo
```

Pass `-reset` to delete demo-owned rows first (requires `DATABASE_URL`) before
reseeding — useful after schema changes or a dirty local DB.

### 9c. Playwright specs (what `pnpm test:e2e` runs, in order)

| Spec | Persona | Covers |
|---|---|---|
| `01-team-admin` | admin (dex primary) | create team, add editor |
| `02-ui-editor` | admin | new template in UI mode: expose `spec.replicas`, label it, save → detail page |
| `03-deprecate-flow` | admin | publish → deprecate → hidden from catalog → undeprecate (confirm dialogs auto-accepted) |
| `04-demo-user` | demo user / demo admin | demo banner, seeded catalog, demo-restricted 403, landing entry buttons |
| `05-user-deploy` | demo user | deploy form: empty-name guard, Korean validation sentence, RBAC denial sentence for `kube-system`, deploy to `default`, delete own release |
| `06-admin-draft-save` | demo admin | seeded `web-app` draft: unsaved-edits guard on tab switch, display-name PATCH save, restore |
| `07-error-pages` | demo user | unknown template / release / team → localized not-found page with a way back |

All specs assume the seed from §9b (templates `web-app`, `nightly-job`, `app-with-config` + a `web-app` draft) and the demo RBAC bindings from §6 (`demo-user` has `edit` in `default`). Anything that pops `window.confirm` needs `autoAcceptDialogs(page)` from `fixtures.ts` — Playwright dismisses dialogs by default, which cancels the action.

### 10. Browser

1. Visit `https://host.docker.internal:5556/.well-known/openid-configuration`
   once, click **Advanced → Proceed** to cache the self-signed cert exception.
2. `http://localhost:3000` → login as `alice@example.com` / `alice`
3. Catalog → Web Service → 배포 → fill form → submit
4. Release detail page should show `healthy` with 1 instance

## UI mode (Plan 2)

Once everything from §9 and §10 is running (logged in as alice):

1. `http://localhost:3000/admin/teams` → create a team, click the team name, add yourself as editor.
2. `http://localhost:3000/templates/new` → pick "Deployment", click `spec.replicas` → mark "사용자 노출", click container image → mark "값 고정" = `nginx:1.25`. Name the template, assign the team, save.
3. Back at `/templates/<name>`, publish v1.
4. `/catalog` → deploy.
5. `/templates/<name>` → Deprecate v1. Verify:
   - `/catalog` no longer lists it,
   - a second deploy attempt returns 400.

## Troubleshooting

### `cluster has no ca_bundle` on OpenAPI fetch

As of the third-round hardening pass, empty `ca_bundle` cluster registrations are
rejected at openapi proxy time to avoid silently trusting any cert. Either (a)
register the cluster WITH its CA (step 9 above already does — `KIND_CA`), or (b)
for bare-bones manual tests, export `KBP_DEV_ALLOW_INSECURE_CLUSTERS=true` on the
backend process. Never set this env in prod.

### kind cluster died between sessions (DB ↔ k8s drift recovery)

**Observed 2026-04-28** — symptoms after a host reboot or Docker Desktop crash:

- `/releases/<id>` renders header + status `unknown` + 0/0 metric + empty
  instances table, with no explanation in the UI.
- `/templates/<name>/versions/<v>/edit?mode=ui` is stuck on
  "스키마 로딩 중…" forever.
- Sidebar cluster picker still lists the dead cluster as if healthy
  (no reachability check yet — sidebar trusts the DB row; Stage 2
  reconciler will surface this, see CLAUDE.md plan 9).
- Frontend log shows `502` on `/api/v1/clusters/<name>/openapi/...`.

**Why it happens.** kind keeps cluster metadata in `~/.kube/config` and Docker
keeps the control-plane container, both of which survive container death.
kubeport's DB has the cluster row + `ca_bundle` pinned at registration time.
If the container dies (host reboot, OOM, Docker Desktop restart with corrupt
state), the row points to a dead endpoint and nothing in the app currently
notices.

A new kind cluster will have a **different CA**, so simply restarting won't fix
the trust chain — the DB row's `ca_bundle` must be replaced.

**Diagnosis.** First confirm you're actually in this state vs. a different
network issue:

```bash
docker ps -a --filter 'label=io.x-k8s.kind.cluster=kubeport' --format '{{.Names}} {{.Status}}'
# stale: "kubeport-control-plane Exited (...)"
# healthy: "kubeport-control-plane Up X minutes"

ss -tlnp 2>/dev/null | grep ':6443' || echo "nothing on 6443"
# stale: "nothing on 6443"
```

**Recovery procedure.**

1. **Delete the dead cluster** (also cleans `~/.kube/config`):

   ```bash
   kind delete cluster --name kubeport
   ```

2. **Recreate** `/tmp/kind-cluster.yaml` if missing (same content as §5 above,
   with `hostPath` adjusted for your home directory) and bring kind back up:

   ```bash
   kind create cluster --config /tmp/kind-cluster.yaml --wait 2m
   ```

3. **Reapply RBAC bindings** (§6 above — `kubeport-admin` ClusterRoleBinding
   + `kubeport-users` RoleBinding in `default`).

4. **Sync the DB `ca_bundle` to the new cluster's CA** — this is the
   easy-to-miss step. Without it the backend keeps failing TLS handshake against
   the new apiserver and you'll see `502` on every `/v1/clusters/<name>/...`
   call:

   ```bash
   KIND_CA_B64=$(kubectl --context kind-kubeport config view --raw --minify --flatten \
     -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
   KIND_CA=$(echo "$KIND_CA_B64" | base64 -d)

   docker exec -i docker-postgres-1 psql -U kubeport -d kubeport -v ca="$KIND_CA" <<'EOF'
   UPDATE clusters SET ca_bundle = :'ca' WHERE name='kind';
   SELECT name, length(ca_bundle) FROM clusters;
   EOF
   # expect: ca_bundle ~1100 bytes for kindest/node v1.30
   ```

   The `-v ca="$KIND_CA"` flag binds the PEM blob to a psql variable, and
   `:'ca'` interpolates it with proper SQL quoting — handles the embedded
   newlines safely without shell/SQL escaping gymnastics. The quoted heredoc
   (`<<'EOF'`) prevents the shell from re-interpreting anything inside.

5. **Verify** the backend can now reach the new cluster end-to-end:

   ```bash
   ADM=$(curl -ks -X POST https://host.docker.internal:5556/token \
     -d grant_type=password -d client_id=kubeport -d client_secret=local-dev-secret \
     -d username=admin@example.com -d password=admin \
     -d 'scope=openid email profile groups' \
     | jq -r .id_token)

   curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
     -H "Authorization: Bearer $ADM" \
     http://localhost:8080/v1/clusters/kind/openapi/v1
   # expect: HTTP 200
   ```

6. **Refresh the browser**. Release detail and UI-mode editor should both
   unstick.

**Stale releases left behind.** Releases that pointed to the previous instance
of the cluster (e.g. `test-web` from earlier sessions) are still in the DB. Their
k8s resources are gone with the old cluster. Until [Plan 8](superpowers/plans/2026-04-28-plan8-release-stale-cleanup.md)
ships an admin-only force-delete UI, your options are:

- **Redeploy the same release name on the new cluster.** The DB row stays and
  the new k8s resources match the existing labels.
- **Manually delete the row** after confirming it's actually orphaned:
  `docker exec -i docker-postgres-1 psql -U kubeport -d kubeport -c "DELETE FROM releases WHERE name='<name>';"`

**Prevention.** Tear down kind cleanly before host shutdown
(`kind delete cluster --name kubeport`) — `docker stop` of the control-plane is
also fine (`docker start` brings it back), but a hard kill (host reboot, Docker
Desktop crash) often leaves the container in `Exited (127)` and the only
reliable recovery is delete + recreate. Plan 9 (deferred) will add a
reconciliation loop that detects this drift automatically; for now it's a
manual playbook.

## Known limits

- **dex staticPasswords ignores the `groups` field.** Even with `groups: [kubeport-admin]` in `dex.yaml`, the issued id_token has no `groups` claim. We work around this two ways:
  - App-level: `KBP_DEV_ADMIN_EMAILS` env var on the backend elevates specific emails. Dev-only.
  - Cluster-level: the `system:authenticated` RoleBinding in `default` namespace is what lets alice deploy. `kubeport-admin` → cluster-admin exists but is never actually matched locally.

  With a real IdP (Okta / Keycloak / etc.) groups come through the id_token normally and `KBP_DEV_ADMIN_EMAILS` stays unset.

- **Self-signed cert.** Browsers need the one-time exception. `NODE_EXTRA_CA_CERTS` (Next.js) and `OIDC_CA_FILE` (Go) handle the server-side trust.

- **kindest/node image.** Default pulled by kind v0.23 is k8s 1.30. That's the one that requires https OIDC. On older kind versions pinned to 1.29, plain http works but you then diverge from the current kind defaults.

- **Restarting dex rotates its signing keys.** dex's `storage.type` is `memory`
  (see `deploy/docker/dex.yaml`) — it has no persisted key material, so every
  `docker compose restart dex` mints a fresh signing key on boot. The kind
  apiserver caches dex's JWKS response and doesn't notice the rotation, so
  tokens issued after the restart fail apiserver-side verification with a
  generic 401 until the apiserver's JWKS cache is invalidated. Force a refresh
  by restarting the apiserver static pod:

  ```bash
  docker exec kubeport-control-plane sh -c 'touch /etc/kubernetes/manifests/kube-apiserver.yaml'
  ```

  kubelet detects the manifest mtime change and restarts the pod, which
  re-fetches JWKS on the next token verification. If that doesn't clear it,
  recreate the kind cluster (§5) — cheaper than debugging a wedged JWKS cache.

## Tear down

```bash
kind delete cluster --name kubeport
docker compose -f deploy/docker/docker-compose.yml down   # keeps pgdata volume
```

Wipe everything including DB: append `-v` to the compose command.
