#!/usr/bin/env bash
# Shared bits for scripts/e2e/*.sh — sourced, not executed.
# Portable across Git Bash (Windows), WSL, macOS and Linux: no jq, no GNU-only
# flags; JSON goes through node, which the frontend already requires.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CERT_DIR="$ROOT/deploy/docker/certs"
DEX_CRT="$CERT_DIR/dex.crt"
ENV_LOCAL="$ROOT/frontend/.env.local"

DEX_ISSUER="https://host.docker.internal:5556"
DB_URL="postgres://kubeport:kubeport@localhost:5432/kubeport?sslmode=disable"
API_URL="http://localhost:8080"
WEB_URL="http://localhost:3000"

# J '<js arrow fn>' — apply a JS function to JSON on stdin, print the result.
#   curl … | J 'o => o.id_token'
J() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(String(($1)(o)))})"; }

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[e2e]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[e2e]\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1 — see docs/dev-setup.md"; }

# Reads KEY=VALUE from frontend/.env.local (first match), empty if absent.
env_local() { [[ -f "$ENV_LOCAL" ]] && grep -m1 "^$1=" "$ENV_LOCAL" | cut -d= -f2- || true; }

# id_token for a dex static user (password grant, local dev only).
dex_token() {
  curl -ks -X POST "$DEX_ISSUER/token" \
    -d grant_type=password -d client_id=kubeport -d client_secret=local-dev-secret \
    -d "username=$1" -d "password=$2" -d 'scope=openid email profile groups' | J 'o => o.id_token || ""'
}
