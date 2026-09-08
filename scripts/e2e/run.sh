#!/usr/bin/env bash
# Run Playwright against the local stack. Extra args go to `playwright test`
# (e.g. `scripts/e2e/run.sh tests/e2e/05-user-deploy.spec.ts --headed`).
# Cached logins live in frontend/tests/e2e/.auth — they go stale after a
# DB reset or a dex restart; pass --fresh to drop them first.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
need pnpm
curl -sf "$API_URL/healthz" >/dev/null || die "backend not up — scripts/e2e/backend.sh"
curl -sf -o /dev/null "$WEB_URL/" || die "frontend not up — scripts/e2e/frontend.sh"

cd "$ROOT/frontend"
if [[ "${1:-}" == "--fresh" ]]; then
  shift
  rm -rf tests/e2e/.auth
  log "dropped cached logins"
fi
[[ -d node_modules/.pnpm/@playwright* ]] || pnpm exec playwright install chromium
export KBP_BASE_URL="$WEB_URL"
exec pnpm exec playwright test "$@"
