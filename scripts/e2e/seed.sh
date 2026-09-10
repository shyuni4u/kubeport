#!/usr/bin/env bash
# Register the kind cluster (once) and seed demo data (docs/local-e2e.md §9/§9b).
# Needs backend.sh running. Pass -reset to wipe demo-owned rows first — do this
# whenever the seed fixtures changed, otherwise the old templates are kept.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need go; need kubectl
curl -sf "$API_URL/healthz" >/dev/null || die "backend not reachable at $API_URL — run scripts/e2e/backend.sh"

ADM="$(dex_token admin@example.com admin)"
[[ -n "$ADM" ]] || die "could not get an admin id_token from dex"

if curl -s -H "Authorization: Bearer $ADM" "$API_URL/v1/clusters" | J 'o => (o.clusters||[]).some(c => c.name==="kind")' | grep -q true; then
  log "cluster 'kind' already registered"
else
  # Register with kind's own CA — it validates the apiserver cert, which kind
  # signs with its internal cluster CA (not dex's).
  KIND_CA="$(kubectl --context kind-kubeport config view --raw --minify --flatten -o json \
    | J 'o => Buffer.from(o.clusters[0].cluster["certificate-authority-data"], "base64").toString()')"
  export KIND_CA
  node -e 'process.stdout.write(JSON.stringify({name:"kind",api_url:"https://127.0.0.1:6443",ca_bundle:process.env.KIND_CA,oidc_issuer_url:process.env.DEX_ISSUER,default_namespace:"default"}))' \
    | DEX_ISSUER="$DEX_ISSUER" curl -sf -H "Authorization: Bearer $ADM" -H 'content-type: application/json' \
        -X POST "$API_URL/v1/clusters" -d @- >/dev/null
  log "cluster 'kind' registered"
fi

# Warm user rows so admin can add them to teams (01-team-admin depends on alice).
for u in "alice@example.com alice" "demo-admin@demo.kubeport demo" "demo-user@demo.kubeport demo"; do
  set -- $u
  TOK="$(dex_token "$1" "$2")"
  [[ -n "$TOK" ]] && curl -sf -H "Authorization: Bearer $TOK" "$API_URL/v1/me" >/dev/null || warn "could not warm $1"
done

cd "$ROOT/backend"
export DEMO_OIDC_ISSUER="$DEX_ISSUER"
export DEMO_OIDC_CLIENT_ID=kubeport
export DEMO_OIDC_CLIENT_SECRET=local-dev-secret
export OIDC_CA_FILE="$DEX_CRT"
export KBP_API_BASE_URL="$API_URL"
export DEMO_ADMIN_EMAIL=demo-admin@demo.kubeport
export DEMO_ADMIN_PASSWORD=demo
export DEMO_USER_EMAIL=demo-user@demo.kubeport
export DEMO_USER_PASSWORD=demo
export DEMO_CLUSTER=kind
export DEMO_NAMESPACE=default
export KBP_DEMO_EMAIL_DOMAIN=demo.kubeport
export DATABASE_URL="$DB_URL"
log "seed-demo $*"
go run ./cmd/seed-demo "$@"
