# Shared by scripts/compose.sh, scripts/test-db.sh and scripts/e2e/common.sh —
# sourced, not executed. Prints nothing except what a function returns, so
# test-db.sh's stdout-is-the-eval-line rule holds.

# main_checkout <dir> — the checkout that owns <dir>'s repository: the main
# checkout for a worktree, the directory itself for a plain clone. The shared
# compose stack lives there, because worktrees are deleted once their PR
# merges and the main checkout is not (#230).
main_checkout() {
  local common
  if common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
      && [[ "$(basename "$common")" == .git ]]; then
    (cd "$(dirname "$common")" && pwd)
  else
    (cd "$1" && pwd)
  fi
}

# norm_path <path> — one spelling for paths Docker Desktop reports
# (C:\Users\…) and Git Bash produces (/c/Users/… or C:/Users/…), so they can be
# compared. Lowercased: Windows paths are case-insensitive.
norm_path() {
  local p="${1//\\//}"
  p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  if [[ "$p" =~ ^/([a-z])/(.*)$ ]]; then
    p="${BASH_REMATCH[1]}:/${BASH_REMATCH[2]}"
  fi
  printf '%s' "${p%/}"
}

# compose_container_workdir <service> — the checkout directory the shared
# compose project's container for <service> was created from, empty if none.
compose_container_workdir() {
  local id
  id="$(docker ps -aq --filter label=com.docker.compose.project=docker \
          --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || return 0
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id" 2>/dev/null || true
}

# running_dex_certs_dir — the host directory the shared dex container mounts
# as /config/certs, empty if there is none.
running_dex_certs_dir() {
  local id
  id="$(docker ps -aq --filter label=com.docker.compose.project=docker \
          --filter label=com.docker.compose.service=dex 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || return 0
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/config/certs"}}{{.Source}}{{end}}{{end}}' "$id" 2>/dev/null || true
}
