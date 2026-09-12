# Shared by scripts/compose.sh and scripts/e2e/doctor.sh — sourced, not
# executed. Prints nothing except what a function returns.
#
# The local stack's issuer is https://host.docker.internal:5556, and host
# processes (backend, BFF, go test) resolve that name through the hosts file.
# dex is published on 127.0.0.1 only (#63), so the entry has to say 127.0.0.1:
# Docker Desktop's own entry is the machine's LAN IP, which a loopback publish
# does not answer, and it goes stale when the LAN IP changes (#298).

# HOSTS_FILES — the file a host process really reads. Under Git Bash that is
# Windows' own: native tools (curl, go, node) use it, and MSYS's /etc/hosts is a
# separate copy Git for Windows ships, which they never read. On Linux, macOS
# and WSL it is /etc/hosts.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) HOSTS_FILES=(/c/Windows/System32/drivers/etc/hosts) ;;
  *) HOSTS_FILES=(/etc/hosts) ;;
esac

# hosts_file_ip <name> <file>... — 127.0.0.1 when any uncommented line maps
# <name> to it, otherwise the address of the first line that maps <name>, from
# the first file that has one. Empty when none does. A UTF-8 BOM (Notepad) and
# CRLF are ignored. Resolvers fall back to the next entry when one refuses, so
# `::1 name` above `127.0.0.1 name` still reaches dex.
# awk reads to the end rather than exiting early, so `tr` never meets a closed
# pipe — callers run under `set -o pipefail`.
hosts_file_ip() {
  local name="$1" f ip
  shift
  for f in "$@"; do
    [[ -r "$f" ]] || continue
    ip="$(tr -d '\r' < "$f" | awk -v n="$name" '
      NR == 1 { sub(/^\357\273\277/, "") }
      { sub(/#.*/, "") }
      NF >= 2 {
        for (i = 2; i <= NF; i++) if (tolower($i) == tolower(n)) {
          if (first == "") first = $1
          if ($1 == "127.0.0.1") ok = 1
          break
        }
      }
      END { if (ok) print "127.0.0.1"; else if (first != "") print first }')"
    if [[ -n "$ip" ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 0
}

# reaches_dex_ip <ip> — whether a hosts entry with this address reaches dex's
# default publish. Exactly 127.0.0.1: docker-compose.yml binds that address,
# so neither ::1 nor another 127.x answers there.
reaches_dex_ip() {
  [[ "$1" == 127.0.0.1 ]]
}
