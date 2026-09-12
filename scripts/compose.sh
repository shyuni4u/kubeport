#!/usr/bin/env bash
# The shared local stack (postgres + dex), always run from the main checkout.
#
#   scripts/compose.sh up -d        # from the main checkout or any worktree
#   scripts/compose.sh ps
#   scripts/compose.sh exec -T postgres psql -U kubeport -d kubeport
#   scripts/compose.sh down         # keeps the pgdata volume
#
# Why (#230): every checkout's deploy/docker is the same compose project,
# `docker` — the name comes from the directory. So
# `docker compose -f deploy/docker/docker-compose.yml up -d` typed inside a
# worktree recreates the SHARED containers from that worktree, and dex then
# bind-mounts that worktree's dex.yaml and certs. Worktrees are deleted when
# their PR merges; deleting that one breaks dex for every session on the
# machine. This runs compose on the main checkout's files, which stay.
#
# The project name is kept on purpose. scripts/test-db.sh finds the shared
# postgres through it, and a new name would start a new, empty pgdata volume
# and fight the old containers for ports 5432 and 5556.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$here/scripts/lib/main-checkout.sh"
. "$here/scripts/lib/hosts.sh"

MAIN="$(main_checkout "$here")"
DIR="$MAIN/deploy/docker"
FILE="$DIR/docker-compose.yml"

say() { printf '\033[1;34m[compose]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[compose]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$FILE" ]] || die "no $FILE — the main checkout was resolved to $MAIN"

case "${1:-}" in
  up|create|start|restart)
    if [[ ! -f "$DIR/certs/dex.crt" || ! -f "$DIR/certs/dex.key" ]]; then
      src="$(running_dex_certs_dir)"
      if [[ -n "$src" ]]; then
        die "$DIR/certs has no dex.crt/dex.key, and certificates are not committed.
  The running dex uses the ones in $src — copy those, do not generate new ones:
  a new CA breaks every session and kind cluster that trusts the current one.
      cp \"$src/dex.crt\" \"$src/dex.key\" \"$DIR/certs/\""
      fi
      die "$DIR/certs has no dex.crt/dex.key, so dex cannot start (certificates are not committed).
  On a new machine, scripts/e2e/up.sh generates them — docs/local-e2e.md §2."
    fi
    for svc in postgres dex; do
      wd="$(compose_container_workdir "$svc")"
      if [[ -n "$wd" && "$(norm_path "$wd")" != "$(norm_path "$DIR")" ]]; then
        say "$svc was created from $wd — it will be recreated from $DIR"
      fi
    done
    # docker-compose.yml publishes dex on ${KBP_DEX_BIND:-127.0.0.1} (#63).
    # compose also reads $DIR/.env, so look there when the shell has nothing.
    bind="${KBP_DEX_BIND:-}"
    if [[ -z "$bind" && -f "$DIR/.env" ]]; then
      bind="$(grep -m1 '^KBP_DEX_BIND=' "$DIR/.env" | cut -d= -f2- || true)"
    fi
    if [[ -n "$bind" && "$bind" != "127.0.0.1" ]]; then
      say "WARNING: dex will be published on $bind:5556 — its passwords are public, so this reaches past this machine unless a firewall blocks it (#63)"
    fi
    # Host processes reach dex as host.docker.internal (dex.yaml's issuer)
    # through the hosts file. A loopback publish does not answer the LAN IP
    # Docker Desktop writes for that name, so the backend and go test would
    # time out on it (#298). Checked whatever the binding: KBP_DEX_BIND=0.0.0.0
    # also makes a wrong entry work — by opening dex to the network — and must
    # not become the way this warning goes away. Warn only; the hosts file is
    # the user's to edit, and its address is not echoed (it can be a public IP).
    hdi="$(hosts_file_ip host.docker.internal "${HOSTS_FILES[@]}")"
    if [[ -n "$hdi" ]] && ! reaches_dex_ip "$hdi"; then
      say "WARNING: the hosts file does not map host.docker.internal to 127.0.0.1 — set that entry to 127.0.0.1 (docs/local-e2e.md §1, #298). Do not work around it with KBP_DEX_BIND=0.0.0.0: that republishes dex's public passwords to your network (#63)"
    fi
    ;;
esac

exec docker compose --project-directory "$DIR" -f "$FILE" "$@"
