# Shared by scripts/compose.sh and scripts/e2e/doctor.sh — sourced, not
# executed. Prints nothing except what a function returns.
#
# The local stack's issuer is https://host.docker.internal:5556, and host
# processes (backend, BFF, go test) resolve that name through the hosts file.
# dex is published on 127.0.0.1 only (#63), so the entry has to say 127.0.0.1:
# Docker Desktop's own entry is the machine's LAN IP, which a loopback publish
# does not answer, and it goes stale when the LAN IP changes (#298).

# HOSTS_FILES — where a host process looks the name up. Windows' file first:
# native tools under Git Bash (curl, go, node) use it, not MSYS's /etc/hosts.
# On Linux, macOS and WSL the Windows path does not exist and /etc/hosts is it.
HOSTS_FILES=(/c/Windows/System32/drivers/etc/hosts /etc/hosts)

# hosts_file_ip <name> <file>... — the address the first uncommented line
# naming <name> maps it to, searching the files in order. Empty when none does.
# awk reads to the end rather than exiting early, so `tr` never meets a closed
# pipe — callers run under `set -o pipefail`.
hosts_file_ip() {
  local name="$1" f ip
  shift
  for f in "$@"; do
    [[ -r "$f" ]] || continue
    ip="$(tr -d '\r' < "$f" | awk -v n="$name" '
      { sub(/#.*/, "") }
      !found && NF >= 2 { for (i = 2; i <= NF; i++) if (tolower($i) == tolower(n)) { print $1; found = 1; break } }')"
    if [[ -n "$ip" ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 0
}

# is_loopback_ip <ip>
is_loopback_ip() {
  [[ "$1" == 127.* || "$1" == ::1 ]]
}
