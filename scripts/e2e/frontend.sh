#!/usr/bin/env bash
# Next.js dev server for local e2e (docs/local-e2e.md §8). Foreground.
# NODE_EXTRA_CA_CERTS makes openid-client trust the self-signed dex cert.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need pnpm
[[ -f "$DEX_CRT" && -f "$ENV_LOCAL" ]] || die "run scripts/e2e/up.sh first"

cd "$ROOT/frontend"
[[ -d node_modules ]] || pnpm install --frozen-lockfile
export NODE_EXTRA_CA_CERTS="$DEX_CRT"
export PORT=3000
log "frontend on $WEB_URL"
exec pnpm dev
