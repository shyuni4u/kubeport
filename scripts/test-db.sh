#!/usr/bin/env bash
# Per-session / per-worktree test database on the compose postgres (docs/testing.md §3.4).
#
#   out=$(scripts/test-db.sh) && eval "$out"          # create kubeport_test_<worktree> + apply schema, export TEST_DATABASE_URL
#   out=$(scripts/test-db.sh foo) && eval "$out"      # same, kubeport_test_foo
#   out=$(scripts/test-db.sh --drop) && eval "$out"   # drop this worktree's DB, unset TEST_DATABASE_URL
#   scripts/test-db.sh --list                         # show every per-session DB on the compose postgres
#
# Not `eval "$(scripts/test-db.sh)"`: on failure the script prints nothing to
# stdout, eval of an empty string succeeds, and the tests that follow fall back
# to the shared `kubeport` DB — the one this script exists to keep them off.
#
# Why: internal/api's TestMain deletes rows by name pattern from whatever
# TEST_DATABASE_URL points at. `go test -p 1` serialises packages inside one
# run, but two sessions on the shared `kubeport` DB still delete each other's
# fixtures mid-test.
#
# stdout carries only the shell line meant for eval; everything else goes to
# stderr. Idempotent. Portable across Git Bash (Windows), WSL, macOS, Linux:
# psql runs inside the postgres container, so no host psql is needed.
# Standalone rather than sourcing scripts/e2e/common.sh, whose log() writes to
# stdout and would corrupt the eval line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="$ROOT/deploy/docker/docker-compose.yml"
PREFIX="kubeport_test_"
# atlas needs an empty scratch DB to normalise the desired schema. One per
# session, on the same compose postgres, so sessions never share it.
DEV_PREFIX="kubeport_atlasdev_"
SHARED_DB="kubeport"
PG_USER="kubeport"
PG_PASS="kubeport"
PG_HOSTPORT="localhost:5432"

log() { printf '\033[1;34m[test-db]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[test-db]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1 — see docs/dev-setup.md"; }

usage() { sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit "${1:-0}"; }

# name → [a-z0-9_], collapsed, trimmed. That mapping is lossy: worktrees
# `fix+a` and `fix-a` would both become `fix_a` and share a DB — the exact
# cross-session deletion this script exists to prevent, and `--drop` from one
# would force-drop the other's. So whenever normalising changed the name, a
# checksum of the ORIGINAL name is appended. Postgres also truncates
# identifiers at 63 bytes silently, so a long name is cut to fit (under the
# longer prefix) with the same checksum.
normalize() {
  local raw="${1#"$PREFIX"}"    # accept a full DB name too
  local n sum=""
  n="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_' '_' | tr -s '_')"
  n="${n#_}"; n="${n%_}"
  [[ -n "$n" ]] || die "cannot derive a DB name from '$1' — pass one: scripts/test-db.sh <name>"
  local max=$(( 63 - ${#DEV_PREFIX} ))
  if [[ "$n" != "$raw" ]] || (( ${#n} > max )); then
    sum="$(printf '%s' "$raw" | cksum | cut -d' ' -f1)"
    local keep=$(( max - ${#sum} - 1 ))
    (( ${#n} <= keep )) || n="${n:0:$keep}"
    n="${n%_}_$sum"
  fi
  printf '%s' "$n"
}

# Worktree directory name: unique per worktree, stable across branch switches.
default_name() {
  local top
  top="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$ROOT")"
  basename "$top"
}

MODE=create
case "${1:-}" in
  --drop) MODE=drop; shift ;;
  --list) MODE=list; shift ;;
  -h|--help) usage 0 ;;
  -*) die "unknown flag: $1 (see --help)" ;;
esac
(( $# <= 1 )) || usage 1

need docker

# The compose project's postgres. Resolved through compose (not a hardcoded
# container name) so a clone in a differently named directory still works.
CID="$(docker compose -f "$COMPOSE" ps -q postgres 2>/dev/null || true)"
[[ -n "$CID" ]] || die "compose postgres is not running — docker compose -f deploy/docker/docker-compose.yml up -d"
docker exec "$CID" pg_isready -U "$PG_USER" -d postgres >/dev/null 2>&1 \
  || die "compose postgres container $CID is up but not accepting connections yet — retry in a few seconds"

psql_c() { docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres -tAc "$1"; }
exists() { [[ -n "$(psql_c "SELECT 1 FROM pg_database WHERE datname = '$1'")" ]]; }

if [[ $MODE == list ]]; then
  psql_c "SELECT datname FROM pg_database
          WHERE datname LIKE '${PREFIX//_/\\_}%' OR datname LIKE '${DEV_PREFIX//_/\\_}%' ORDER BY 1"
  exit 0
fi

NAME="$(normalize "${1:-$(default_name)}")"
DB="$PREFIX$NAME"
DEV_DB="$DEV_PREFIX$NAME"
# Belt and braces: the prefixes make this unreachable, but the shared DB must
# never be the target of a drop or a schema apply from this script.
[[ "$DB" != "$SHARED_DB" && "$DEV_DB" != "$SHARED_DB" && "$DB" == "$PREFIX"?* && "$DEV_DB" == "$DEV_PREFIX"?* ]] \
  || die "refusing to touch '$DB'"

if [[ $MODE == drop ]]; then
  for d in "$DB" "$DEV_DB"; do
    if exists "$d"; then
      # FORCE: a killed test binary can leave a pooled connection behind, and
      # this DB belongs to this session only.
      psql_c "DROP DATABASE \"$d\" WITH (FORCE)" >/dev/null
      log "dropped $d"
    else
      log "$d does not exist — nothing to drop"
    fi
  done
  echo "unset TEST_DATABASE_URL"
  exit 0
fi

need atlas
for d in "$DB" "$DEV_DB"; do
  if exists "$d"; then
    log "$d exists"
  else
    # template0: CREATE DATABASE copies template1 and fails if anyone else is
    # connected to it — template0 never accepts connections, so sessions
    # creating their DBs at the same moment can't trip over each other.
    psql_c "CREATE DATABASE \"$d\" OWNER $PG_USER TEMPLATE template0" >/dev/null
    log "created $d"
  fi
done

URL="postgres://$PG_USER:$PG_PASS@$PG_HOSTPORT/$DB?sslmode=disable"
DEV_URL="postgres://$PG_USER:$PG_PASS@$PG_HOSTPORT/$DEV_DB?sslmode=disable"

# Same atlas env and schema.hcl that CI applies (.github/workflows/ci.yml
# "Apply DB schema"), pointed at this DB. The one difference is the dev DB:
# CI's docker://postgres/16/dev starts a container per apply, and on some
# Docker Desktop hosts atlas cannot reach it (it dials the host's LAN IP and
# hangs ~70s). The compose postgres is the same major (16), so the plan is the
# same. Idempotent: an up-to-date DB is a no-op.
log "atlas schema apply → $DB"
# The full plan is a screenful of DDL on a fresh DB; show it only on failure.
if ! OUT="$(cd "$ROOT/backend/migrations" \
      && atlas schema apply --env local --var "url=$URL" --var "dev=$DEV_URL" --auto-approve 2>&1)"; then
  printf '%s\n' "$OUT" >&2
  die "atlas schema apply failed for $DB"
fi
case "$OUT" in
  *"Schema is synced"*) log "schema already up to date" ;;
  *) log "schema applied ($(printf '%s\n' "$OUT" | grep -c -- '-- ok') statements)" ;;
esac

log "ready — go test -p 1 ./... now uses $DB"
echo "export TEST_DATABASE_URL='$URL'"
