#!/usr/bin/env bash
# Preflight for local Playwright e2e (docs/local-e2e.md §0). Read-only.
# Prints what is present/missing so a fresh machine knows exactly what to do.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
. "$ROOT/scripts/lib/hosts.sh"

ok=1
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then log "ok   $label"; else warn "MISSING $label"; ok=0; fi
}

log "repo: $ROOT"
for t in docker kind kubectl atlas go node pnpm curl openssl; do check "tool $t" command -v "$t"; done

# The entry must say 127.0.0.1, not merely exist: dex is published on loopback
# only (#63), and Docker Desktop's own entry is the LAN IP (#298).
hdi_ip="$(hosts_file_ip host.docker.internal "${HOSTS_FILES[@]}")"
check "hosts entry host.docker.internal → 127.0.0.1" is_loopback_ip "$hdi_ip"
if [[ -n "$hdi_ip" ]] && ! is_loopback_ip "$hdi_ip"; then
  warn "        host.docker.internal is $hdi_ip in the hosts file — set it to 127.0.0.1 (docs/local-e2e.md §1)"
fi
check "dex cert $DEX_CRT" test -f "$DEX_CRT"
check "frontend/.env.local" test -f "$ENV_LOCAL"
check "postgres container running" sh -c 'docker ps --format "{{.Names}} {{.Status}}" | grep -q "postgres.*Up"'
check "dex container running"      sh -c 'docker ps --format "{{.Names}} {{.Status}}" | grep -q "dex.*Up"'
check "dex discovery reachable"    curl -ksf "$DEX_ISSUER/.well-known/openid-configuration"
check "kind cluster 'kubeport'"    sh -c 'kind get clusters 2>/dev/null | grep -qx kubeport'
check "kind apiserver answering"   kubectl --context kind-kubeport get ns default
check "demo rolebindings in default" sh -c 'kubectl --context kind-kubeport get rolebinding -n default demo-admin demo-user'
check "backend :8080"              curl -sf "$API_URL/healthz"
check "frontend :3000"             curl -sf -o /dev/null "$WEB_URL/"

if [[ $ok == 1 ]]; then
  log "everything is up — run: scripts/e2e/run.sh"
else
  warn "fix the MISSING lines above. Order: docs/local-e2e.md §1–§3 once per machine, then scripts/e2e/up.sh → backend.sh → frontend.sh → seed.sh → run.sh"
  exit 1
fi
