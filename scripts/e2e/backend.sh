#!/usr/bin/env bash
# Go backend for local e2e (docs/local-e2e.md §7). Foreground — run in its own
# terminal or `... &`. Reads APP_ENCRYPTION_KEY_B64 from frontend/.env.local so
# both sides share it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need go
[[ -f "$DEX_CRT" && -f "$ENV_LOCAL" ]] || die "run scripts/e2e/up.sh first"

KEY="$(env_local APP_ENCRYPTION_KEY_B64)"
[[ -n "$KEY" ]] || die "APP_ENCRYPTION_KEY_B64 missing in $ENV_LOCAL"

cd "$ROOT/backend"
export LISTEN_ADDR=:8080
export DATABASE_URL="$DB_URL"
export OIDC_ISSUER="$DEX_ISSUER"
export OIDC_AUDIENCE=kubeport
export OIDC_CA_FILE="$DEX_CRT"
export APP_ENCRYPTION_KEY_B64="$KEY"
# Local stand-in for the kubeport-admin group (dex static users carry no groups).
export KBP_DEV_ADMIN_EMAILS=admin@example.com,demo-admin@demo.kubeport
export KBP_DEMO_EMAIL_DOMAIN=demo.kubeport
log "backend on $API_URL"
exec go run ./cmd/server
