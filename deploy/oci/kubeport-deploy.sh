#!/usr/bin/env bash
# kubeport-deploy — the one way a new image reaches production.
#
# Installed on the OCI VM as /usr/local/bin/kubeport-deploy (root:root 0755)
# and reached two ways, both of which go through the same grammar and the same
# lock:
#
#   1. GitHub Actions (.github/workflows/deploy.yml) with a deploy-only SSH key
#      pinned in ~ubuntu/.ssh/authorized_keys as
#        restrict,command="/usr/local/bin/kubeport-deploy --forced" ssh-ed25519 AAAA... kubeport-gha-deploy
#      sshd then ignores whatever command the client asked for, runs this
#      script with the literal argument --forced, and hands the request over
#      in $SSH_ORIGINAL_COMMAND.
#
#   2. An operator on the admin key:
#        ssh -i "$KEY" ubuntu@<host> kubeport-deploy deploy <40-hex sha>
#      The request comes from argv. Only this path accepts
#      --allow-dex-restart (see "Dex guard" below), and only this path can
#      move production backwards (see verify_forward).
#
# Which path a request is on is decided by the --forced argument, which only
# authorized_keys supplies — never by whether $SSH_ORIGINAL_COMMAND happens to
# be set. An authorized_keys line without --forced reaches main() with empty
# argv and is rejected.
#
# Requests (nothing else is accepted):
#   status                      helm history, deployed images, lock state
#   deploy <40-hex sha>         deploy that main commit's images + chart
#
# Exit codes — keep them stable:
#   0  done               2  request rejected (grammar, or not forward on the deploy key)
#   3  lock busy          4  sha is not on main / chart unavailable
#   10 Dex guard refused  1  anything else — see the result line for which kind
#
# Every deploy ends with exactly one `KUBEPORT_DEPLOY_RESULT=<name>` line on
# stdout. deploy.yml reads that line, not the exit code, because exit 1 covers
# outcomes that need opposite responses:
#   aborted-before-upgrade   stopped before helm upgrade; the cluster is unchanged
#   failed-rolled-back       helm upgrade failed and helm rolled back
#   failed-rollout / failed-image-mismatch / failed-values-drift / failed-after-upgrade
#                            the NEW revision is live and was not rolled back
#   failed-during-upgrade    ended while helm upgrade was running; state unknown
# and, with their own exit codes: deployed, deployed-dex-restarted, rejected,
# refused-not-forward, lock-busy, unverified, dex-guard-refused.
#
# See docs/oci-prod-runbook.md §3 and deploy/oci/README.md "자동 배포 설치".

set -Eeuo pipefail
export LC_ALL=C

readonly REPO="shyuni4u/kubeport"
readonly RELEASE="kubeport"
readonly NAMESPACE="kubeport"
readonly LOCK_FILE="/run/lock/kubeport-deploy.lock"
readonly LOCK_WAIT_SECONDS=600
readonly HELM_TIMEOUT="10m"
readonly VM_CHART_COPY="${HOME:-/home/ubuntu}/kubeport-chart/kubeport"
readonly EX_REJECTED=2 EX_LOCKED=3 EX_UNVERIFIED=4 EX_DEX_GUARD=10
# Settings that live only in the release's stored values (set once by --set,
# not in values-oci-phase2.yaml's defaults) and whose silent loss has already
# cost an outage or a blind monitor: resetHostAliasIP (reset Job cannot reach
# Dex → preflight fails, runbook §5), publicHealthCatalog (uptime-ping goes
# blind, §3-2), allowTemplateCreate (the demo authoring gate, §5). Printed
# before and after every deploy and checked for drift.
readonly WATCHED_VALUES=(demo.resetHostAliasIP demo.publicHealthCatalog demo.allowTemplateCreate)

# Stated, not inherited: `ssh host "cmd"` does not read a profile, and a
# forced command certainly does not (runbook §3-2). k3s writes this file 0644
# (bootstrap.sh --write-kubeconfig-mode 644), so no sudo is needed — and none
# must be used, or the lock and work files end up root-owned.
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

log() { printf '[kubeport-deploy] %s\n' "$*" >&2; }
# The caller's address for syslog. SSH_CONNECTION is unset for a local run, and
# `set -u` would abort on a bare expansion of it.
client() {
  local c=${SSH_CONNECTION:-local}
  printf '%s' "${c%% *}"
}
syslog() { command -v logger >/dev/null 2>&1 && logger -t kubeport-deploy -- "$*" || true; }
RESULT_EMITTED=0
result() {
  RESULT_EMITTED=1
  printf 'KUBEPORT_DEPLOY_RESULT=%s\n' "$1"
  syslog "result=$1 ${2:-}"
}
die() {
  local code=$1
  shift
  log "ERROR: $*"
  exit "$code"
}

# ---------------------------------------------------------------------------
# Request parsing
# ---------------------------------------------------------------------------

# parse_request <raw> <from_forced_command 0|1>
# Sets REQ_CMD, REQ_SHA, REQ_ALLOW_DEX_RESTART. Never evaluates, splits or
# globs the input: the whole string has to match one anchored pattern. Bash's
# =~ does not compile with REG_NEWLINE, so ^ and $ are the ends of the string
# and "deploy <sha>\nrm -rf ~" cannot sneak past on a second line.
parse_request() {
  local raw=$1 forced=$2
  REQ_CMD="" REQ_SHA="" REQ_ALLOW_DEX_RESTART=0
  if ((${#raw} > 128)); then
    return 1
  fi
  if [[ $raw =~ ^status$ ]]; then
    REQ_CMD=status
    return 0
  fi
  if [[ $raw =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
    REQ_CMD=deploy REQ_SHA=${BASH_REMATCH[1]}
    return 0
  fi
  # The Dex override is for a human who has read the refusal and is about to
  # restart k3s. The deploy key never gets it: a workflow cannot do the second
  # half, so letting it do the first half is how 2026-09-10 happens unattended.
  if [[ $forced == 0 && $raw =~ ^deploy\ ([0-9a-f]{40})\ --allow-dex-restart$ ]]; then
    REQ_CMD=deploy REQ_SHA=${BASH_REMATCH[1]} REQ_ALLOW_DEX_RESTART=1
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------

# Every deploy — workflow or operator — takes this lock, so two helm upgrades
# can never interleave. A plain `helm upgrade` typed by hand does NOT take it;
# that is why the runbook routes manual deploys through this script too.
#
# The file is opened read-only: flock does not need write access, and a lock
# file some earlier `sudo` run left root-owned 0644 is still openable.
acquire_lock() {
  if [[ ! -e $LOCK_FILE ]]; then
    (umask 022 && : >>"$LOCK_FILE")
  fi
  exec 9<"$LOCK_FILE"
  if ! flock -w "$LOCK_WAIT_SECONDS" 9; then
    result lock-busy
    die "$EX_LOCKED" "another deploy has held $LOCK_FILE for ${LOCK_WAIT_SECONDS}s — see \`kubeport-deploy status\`"
  fi
}

lock_state() {
  if [[ ! -e $LOCK_FILE ]]; then
    echo "free (no lock file yet)"
  elif (exec 8<"$LOCK_FILE" && flock -n 8); then
    echo "free"
  else
    echo "HELD — a deploy is in progress"
  fi
}

# ---------------------------------------------------------------------------
# Source verification and chart
# ---------------------------------------------------------------------------

# The deploy key can name any sha, and GitHub serves commits that exist only in
# a fork through the parent repository's archive URL. The chart runs with this
# node's admin kubeconfig, so "any sha" would mean "any manifest anyone can
# push to a fork". Requiring the commit to be reachable from main narrows a
# leaked deploy key to "can redeploy something that was already merged", and
# verify_forward narrows that again to "…and not older than what is live".
# Both paths run this check.
#
# compare/main...<sha>: "behind" = sha is an ancestor of main, "identical" =
# sha is main. Anything else (ahead, diverged, 404) is refused. Fails closed
# when GitHub is unreachable.
verify_on_main() {
  local sha=$1 body status
  if ! body=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/compare/main...$sha?per_page=1"); then
    result unverified
    die "$EX_UNVERIFIED" "could not ask GitHub whether $sha is on main (refusing rather than guessing)"
  fi
  status=$(jq -r '.status // empty' <<<"$body" 2>/dev/null) || status=""
  case $status in
    behind | identical) log "sha $sha is on main ($status)" ;;
    *)
      result unverified
      die "$EX_UNVERIFIED" "sha $sha is not on main (compare status: ${status:-none})"
      ;;
  esac
}

# On main is not enough for the deploy key. Every commit before a security fix
# (#47, #101) is also on main, so a leaked deploy key could otherwise put the
# vulnerable build back. The forced-command path therefore only moves forward:
# the requested sha must be the live one or a descendant of it. Rolling back is
# a human decision and goes through the admin key, which skips this check.
#
# "Live" is the backend Deployment's image tag, which this script sets to
# sha-<7 hex>. compare/<live>...<sha>: "ahead" = sha descends from live,
# "identical" = same commit. behind, diverged, a tag of any other shape
# (latest, a digest) and an unreachable GitHub are all refused — there is
# nothing trustworthy to compare against.
refuse_not_forward() {
  log "ERROR: $1"
  log "the deploy key only moves production forward — rollback needs the admin key:"
  log "  ssh -i \"\$KEY\" ubuntu@<host> kubeport-deploy deploy <40-hex sha>   (docs/oci-prod-runbook.md §3-2)"
  result refused-not-forward
  exit "$EX_REJECTED"
}

verify_forward() {
  local sha=$1 img live body status
  img=$(kubectl get "deploy/$RELEASE-backend" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null) || img=""
  if [[ ! ${img##*:} =~ ^sha-([0-9a-f]{7})$ ]]; then
    refuse_not_forward "live backend image is '${img:-<unreadable>}', not a sha-<7 hex> tag — cannot tell whether $sha is forward"
  fi
  live=${BASH_REMATCH[1]}
  if ! body=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/compare/$live...$sha?per_page=1"); then
    refuse_not_forward "could not ask GitHub how $sha relates to live sha-$live"
  fi
  status=$(jq -r '.status // empty' <<<"$body" 2>/dev/null) || status=""
  case $status in
    ahead | identical) log "sha $sha is forward of live sha-$live ($status)" ;;
    *) refuse_not_forward "sha $sha is not forward of live sha-$live (compare status: ${status:-none})" ;;
  esac
}

# Chart source: the chart **at the deployed sha**, fetched from GitHub — not
# the long-lived copy in ~/kubeport-chart/kubeport.
#
# Why not the VM copy: it only changes when someone remembers to scp it
# (runbook §3-2), so an image that needs a new env var or template would be
# rolled out with last month's templates. Until this script it was kept in step
# by hand — on 2026-09-10 (rev 19) it matched main, all 34 files, only because
# the session deploying had just copied it over. Pairing chart and image by the same
# sha removes that whole class, and it is what makes rollback-by-sha mean
# rollback of both.
#
# Why this is safe for values: see render_values() — the new chart's defaults
# come from the new chart, the operator's settings (secrets, demo gates, the
# phase2 overrides applied at install) come from the release.
fetch_chart() {
  local sha=$1 dest=$2
  local top="${REPO##*/}-$sha"
  if ! curl -fsSL --max-time 120 -o "$dest/src.tar.gz" \
    "https://codeload.github.com/$REPO/tar.gz/$sha"; then
    result unverified
    die "$EX_UNVERIFIED" "could not download $REPO@$sha"
  fi
  # Guarded: under set -e a missing path would exit with tar's own status 2,
  # which reads as "request rejected".
  if ! tar -xzf "$dest/src.tar.gz" -C "$dest" "$top/deploy/helm/kubeport"; then
    result unverified
    die "$EX_UNVERIFIED" "no deploy/helm/kubeport in $REPO@$sha (or the archive is unreadable)"
  fi
  CHART_DIR="$dest/$top/deploy/helm/kubeport"
  if [[ ! -f $CHART_DIR/Chart.yaml ]]; then
    result unverified
    die "$EX_UNVERIFIED" "no chart at deploy/helm/kubeport in $sha"
  fi
}

# Values: the release's own user-supplied values, re-applied on top of the new
# chart's defaults. This is exactly what `--reset-then-reuse-values` does, but
# as an explicit file so the Dex guard can render with byte-for-byte the same
# inputs the upgrade will use.
#
# Why not `--reuse-values`: it keeps the *old chart's* defaults, so a key the
# new chart introduces renders empty (runbook §3-2 — `Namespace ""`, the missing
# demo.publicHealthCatalog). Why not `-f values-oci-phase2.yaml`: its secrets
# are blank placeholders and would overwrite the real ones (README §7.6).
# Everything that file set at install time is already in these values.
#
# JSON rather than YAML: helm reads it through -f all the same (JSON is YAML),
# and jq can read it for the watched-values check without another parser.
#
# The file holds every production secret. It lives in a 0700 mktemp dir that
# the EXIT trap removes, and nothing in this script prints it.
render_values() {
  local out=$1
  helm get values "$RELEASE" -n "$NAMESPACE" -o json >"$out"
  if [[ ! -s $out ]] || [[ "$(jq -c 'if type == "object" then length else 0 end' "$out")" == 0 ]]; then
    die 1 "release $RELEASE has no user-supplied values — refusing to deploy on chart defaults alone"
  fi
}

# watched_values <values json> — "key=value" per WATCHED_VALUES, "<unset>" if absent.
watched_values() {
  local k
  for k in "${WATCHED_VALUES[@]}"; do
    printf '%s=%s\n' "$k" "$(jq -r --arg p "$k" \
      'getpath($p | split(".")) | if . == null then "<unset>" else tostring end' "$1")"
  done
}

# The user-supplied values with the image tags removed and emptied objects
# pruned — the part of the release's configuration a deploy must not change.
values_without_tags() {
  jq -S 'del(.images.backend.tag, .images.frontend.tag)
         | walk(if type == "object" then with_entries(select(.value != {})) else . end)' "$1"
}

# verify_values <values json used for the upgrade> <workdir> <sha>
# The upgrade re-applied the release's own values, so after it the stored
# values must equal what went in, apart from the two image tags. This is a
# tripwire rather than an expected failure, and it is reported rather than
# rolled back: the release is healthy, and whether to keep it is a human call.
verify_values() {
  local before=$1 work=$2 sha=$3
  helm get values "$RELEASE" -n "$NAMESPACE" -o json >"$work/values.after.json"
  echo "--- watched values (before -> after) ---"
  paste -d ' ' <(watched_values "$before") <(watched_values "$work/values.after.json" | sed 's/^[^=]*=/-> /')
  if watched_values "$work/values.after.json" | grep -q '=<unset>$'; then
    log "WARN: a watched value is unset on this release — see WATCHED_VALUES for what each one breaks"
  fi
  if ! cmp -s <(values_without_tags "$before") <(values_without_tags "$work/values.after.json"); then
    # Key names only; the values include secrets.
    log "ERROR: release values changed outside images.*.tag. Differing top-level keys:"
    jq -r -n --slurpfile a "$before" --slurpfile b "$work/values.after.json" \
      '($a[0] + $b[0] | keys[]) as $k | select($a[0][$k] != $b[0][$k]) | "    " + $k' >&2
    log "inspect: helm get values $RELEASE -n $NAMESPACE --revision <prev>  vs  current; roll back with helm rollback if wrong"
    result failed-values-drift "$sha"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Dex guard
# ---------------------------------------------------------------------------

# Dex runs with `storage: memory`. Any upgrade that changes its pod template
# restarts it, a restarted Dex signs with a new key, and the apiserver keeps
# validating demo tokens against the cached old JWKS: logins succeed, every
# cluster call is 401, /healthz stays green — until someone runs
# `sudo systemctl restart k3s` (runbook §5, the 2026-09-10 incident).
#
# A workflow cannot do that second step safely, so an upgrade that would
# restart Dex is refused and handed to a human.
#
# What counts: the rendered Dex Deployment, ConfigMap and Secret. The
# ConfigMap and Secret reach the pod template through checksum annotations,
# and the pod template also carries helm.sh/chart — so a chart version bump
# restarts Dex too, and is correctly caught here.
#
# How: the manifest helm last applied (`helm get manifest`) against a
# `helm template` of the new chart with the identical values and --set flags
# the upgrade will use. Documents are matched by their `# Source:` template
# path, or by kind + the dex component label if a template is ever renamed.
# Blank lines and document order are normalised away; everything else must be
# equal. Anything that cannot be rendered or compared fails the deploy before
# helm touches the cluster.

# dex_docs <manifest file> — one line per Dex document: "<kind>|<name>\t<doc>"
# with the document's newlines folded, sorted. mawk-compatible (Ubuntu's awk).
dex_docs() {
  awk '
    function flush() {
      if (doc != "" && (bysource || (bylabel && kind ~ /^(Deployment|ConfigMap|Secret)$/))) {
        printf "%s|%s\t%s\n", kind, name, doc
      }
      doc = ""; kind = ""; name = ""; inmeta = 0; bysource = 0; bylabel = 0
    }
    /^---[ \t]*\r?$/ { flush(); next }
    {
      sub(/\r$/, "")
      if ($0 ~ /^[ \t]*$/) next
      if ($0 ~ /^# Source: .*\/templates\/dex-(deployment|configmap|secret)\.yaml$/) bysource = 1
      if ($0 ~ /^kind: /) kind = substr($0, 7)
      if ($0 ~ /^metadata:/) inmeta = 1
      else if ($0 ~ /^[^ #]/) inmeta = 0
      if (inmeta && name == "" && $0 ~ /^  name: /) name = substr($0, 9)
      if (inmeta && $0 ~ /^    app\.kubernetes\.io\/component: "?dex"?$/) bylabel = 1
      doc = doc $0 "\\n"
    }
    END { flush() }
  ' "$1" | sort
}

# dex_guard <current manifest> <new manifest> <workdir>
# 0 = Dex unchanged (or absent from both), 10 = Dex would change.
dex_guard() {
  local cur=$1 new=$2 work=$3
  dex_docs "$cur" >"$work/dex.cur"
  dex_docs "$new" >"$work/dex.new"
  if cmp -s "$work/dex.cur" "$work/dex.new"; then
    log "Dex guard: $(wc -l <"$work/dex.new" | tr -d ' ') Dex document(s), unchanged"
    return 0
  fi
  # Names only. The documents include the Dex client secret and the demo
  # password hashes, and this output ends up in a public Actions log.
  log "Dex guard: this upgrade changes Dex:"
  awk -F '\t' '
    NR == FNR { a[$1] = $0; next }
    { b[$1] = $0 }
    END {
      n = 0
      for (k in a) { if (!(k in b)) { print "    removed: " k; n++ } else if (a[k] != b[k]) { print "    changed: " k; n++ } }
      for (k in b) if (!(k in a)) { print "    added:   " k; n++ }
      if (n == 0) print "    (documents differ in count or order of duplicates)"
    }
  ' "$work/dex.cur" "$work/dex.new" >&2
  return "$EX_DEX_GUARD"
}

dex_refusal_message() {
  local sha=$1
  cat >&2 <<EOF

  ======================================================================
  REFUSED: deploying $sha would restart Dex.
  ======================================================================
  Dex keeps its signing keys in memory. After it restarts, the apiserver
  keeps trusting the OLD keys: demo logins work, every cluster call is 401,
  and /healthz stays green. Only restarting k3s clears it (runbook §5).

  Nothing was changed. Deploy this one by hand, and restart k3s right after:

    # runbook §1 "SSH 키 위치" for \$KEY
    ssh -i "\$KEY" ubuntu@<host> 'kubeport-deploy deploy $sha --allow-dex-restart'
    ssh -i "\$KEY" ubuntu@<host> 'sudo systemctl restart k3s && sleep 30 && \\
      START=\$(systemctl show k3s -p ActiveEnterTimestamp --value) && \\
      sudo journalctl -u k3s --since "\$START" --no-pager | grep -c "failed to verify id token signature"'
    # expect 0; then log in as the demo user and open a release's detail page

  Procedure and background: docs/oci-prod-runbook.md §3 "수동 배포".
  ======================================================================
EOF
}

# ---------------------------------------------------------------------------
# Helm
# ---------------------------------------------------------------------------

# Helm 3 spells automatic rollback --atomic; Helm 4 renamed it
# --rollback-on-failure (which also defaults --wait to "watcher"). bootstrap.sh
# installs the pinned HELM_VERSION (a 3.x), but a node whose helm was installed
# or upgraded by hand may run 4, so decide at run time instead of pinning one
# spelling.
rollback_flag() {
  local v
  v=$(helm version --template '{{.Version}}' 2>/dev/null) || die 1 "helm is not runnable"
  case $v in
    v3.*) echo "--atomic" ;;
    v4.*) echo "--rollback-on-failure" ;;
    *) die 1 "unrecognised helm version '$v'" ;;
  esac
}

image_args() {
  local tag=$1
  printf '%s\n' --set "images.backend.tag=$tag" --set "images.frontend.tag=$tag"
}

render_new_manifest() {
  local chart=$1 values=$2 tag=$3 out=$4
  local -a sets
  mapfile -t sets < <(image_args "$tag")
  helm template "$RELEASE" "$chart" -n "$NAMESPACE" -f "$values" "${sets[@]}" >"$out"
}

# run_upgrade <chart> <values> <tag> <rollback flag>
# The flag is resolved by the caller before this runs: this function is called
# under `if !`, where set -e is off, so a failed lookup in here would go on to
# upgrade without a rollback flag.
run_upgrade() {
  local chart=$1 values=$2 tag=$3 flag=$4
  local -a sets
  mapfile -t sets < <(image_args "$tag")
  log "helm upgrade $RELEASE -> $tag ($flag, timeout $HELM_TIMEOUT)"
  helm upgrade "$RELEASE" "$chart" -n "$NAMESPACE" -f "$values" "${sets[@]}" \
    "$flag" --timeout "$HELM_TIMEOUT"
}

print_state() {
  echo "--- helm history (last 3) ---"
  helm history "$RELEASE" -n "$NAMESPACE" | tail -3 || true
  echo "--- deployed images ---"
  kubectl get deploy -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}' || true
}

# Other runbook procedures (demo password rotation, README §7.6) still point
# helm at ~/kubeport-chart/kubeport. Keep that copy equal to what is live so
# those commands do not quietly roll the templates back. Best effort.
sync_vm_chart_copy() {
  local src=$1 sha=$2 parent
  parent=$(dirname "$VM_CHART_COPY")
  {
    mkdir -p "$parent" &&
      rm -rf "$VM_CHART_COPY.new" &&
      cp -r "$src" "$VM_CHART_COPY.new" &&
      printf '%s\n' "$sha" >"$VM_CHART_COPY.new/.deployed-sha" &&
      rm -rf "$VM_CHART_COPY.old" &&
      { [[ ! -e $VM_CHART_COPY ]] || mv "$VM_CHART_COPY" "$VM_CHART_COPY.old"; } &&
      mv "$VM_CHART_COPY.new" "$VM_CHART_COPY" &&
      rm -rf "$VM_CHART_COPY.old"
  } || log "WARN: could not refresh $VM_CHART_COPY (deploy itself succeeded)"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

require_tools() {
  local t missing=()
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  ((${#missing[@]} == 0)) || die 1 "missing on this host: ${missing[*]}"
}

cmd_status() {
  require_tools helm kubectl flock
  echo "lock: $(lock_state)"
  if [[ -f $VM_CHART_COPY/.deployed-sha ]]; then
    echo "chart copy: $(cat "$VM_CHART_COPY/.deployed-sha")"
  fi
  print_state
}

# Where cmd_deploy is, for the EXIT trap: a path that ends without calling
# result() (a die, or a command failing under set -e) still reports which side
# of `helm upgrade` it stopped on.
DEPLOY_PHASE=""
WORK_DIR=""

on_deploy_exit() {
  local rc=$?
  if ((rc != 0 && RESULT_EMITTED == 0)); then
    case $DEPLOY_PHASE in
      before-upgrade)
        log "stopped before helm upgrade — nothing on the cluster was changed"
        result aborted-before-upgrade
        ;;
      upgrade)
        log "ended while helm upgrade was running — check \`kubeport-deploy status\`; a pending-upgrade release needs runbook §7"
        result failed-during-upgrade
        ;;
      after-upgrade)
        log "the new revision is live, but checking it failed — see the history above"
        result failed-after-upgrade
        ;;
    esac
    # Keep the documented codes: whatever command failed (jq 5, curl 22, tar 2)
    # must not be read as one of 2/3/4/10.
    rc=1
  fi
  if [[ -n $WORK_DIR ]]; then rm -rf "$WORK_DIR"; fi
  exit "$rc"
}

# cmd_deploy <sha> <allow dex restart 0|1> <forced 0|1>
cmd_deploy() {
  local sha=$1 allow_dex=$2 forced=$3 tag="sha-${1:0:7}" work flag release_status
  DEPLOY_PHASE="before-upgrade"
  trap on_deploy_exit EXIT
  require_tools helm kubectl curl jq tar flock awk cmp sort paste sed

  acquire_lock
  syslog "deploy $sha requested from $(client) forced=$forced allow_dex_restart=$allow_dex"

  umask 077
  work=$(mktemp -d "${TMPDIR:-/tmp}/kubeport-deploy.XXXXXX")
  WORK_DIR=$work

  verify_on_main "$sha"
  if ((forced == 1)); then
    verify_forward "$sha"
  fi

  # An interrupted upgrade (a cancelled run, a dropped ssh session, a reboot)
  # leaves the release pending-*, and every later upgrade fails with "another
  # operation is in progress". Say so here, before the cluster is touched,
  # instead of reporting it as a failed-and-rolled-back upgrade.
  release_status=$(helm status "$RELEASE" -n "$NAMESPACE" -o json | jq -r '.info.status // empty')
  case $release_status in
    pending-*) die 1 "release $RELEASE is $release_status — a previous helm operation did not finish. Fix by hand: runbook §7 'another operation (install/upgrade/rollback) is in progress'" ;;
  esac
  flag=$(rollback_flag)

  fetch_chart "$sha" "$work"
  render_values "$work/values.json"

  helm get manifest "$RELEASE" -n "$NAMESPACE" >"$work/current.yaml"
  render_new_manifest "$CHART_DIR" "$work/values.json" "$tag" "$work/new.yaml"

  local guard=0
  dex_guard "$work/current.yaml" "$work/new.yaml" "$work" || guard=$?
  if ((guard == EX_DEX_GUARD)); then
    if ((allow_dex == 0)); then
      dex_refusal_message "$sha"
      result dex-guard-refused "$sha"
      exit "$EX_DEX_GUARD"
    fi
    log "Dex will restart (--allow-dex-restart). Restart k3s as soon as this finishes."
  elif ((guard != 0)); then
    die 1 "Dex guard could not compare manifests"
  fi

  DEPLOY_PHASE="upgrade"
  if ! run_upgrade "$CHART_DIR" "$work/values.json" "$tag" "$flag"; then
    log "helm upgrade failed; helm rolled the release back"
    print_state
    result failed-rolled-back "$sha"
    exit 1
  fi
  DEPLOY_PHASE="after-upgrade"

  # helm already waited; this is the explicit, readable confirmation.
  local d
  for d in backend frontend; do
    if ! kubectl rollout status "deploy/$RELEASE-$d" -n "$NAMESPACE" --timeout=120s; then
      print_state
      result failed-rollout "$sha"
      exit 1
    fi
  done
  print_state

  local img bad=0
  for d in backend frontend; do
    img=$(kubectl get "deploy/$RELEASE-$d" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')
    [[ $img == *":$tag" ]] || {
      log "deploy/$RELEASE-$d runs $img, expected tag $tag"
      bad=1
    }
  done
  ((bad == 0)) || {
    result failed-image-mismatch "$sha"
    exit 1
  }

  verify_values "$work/values.json" "$work" "$sha"

  sync_vm_chart_copy "$CHART_DIR" "$sha"

  if ((guard == EX_DEX_GUARD)); then
    log "Dex restarted. Now: sudo systemctl restart k3s  (runbook §5) — until then demo cluster calls are 401."
    result deployed-dex-restarted "$sha"
  else
    result deployed "$sha"
  fi
}

main() {
  local raw forced
  # --forced is written into authorized_keys and nowhere else. It is the whole
  # of how the deploy key's requests are told apart: an unset or empty
  # SSH_ORIGINAL_COMMAND on that path is an empty request and is rejected, and
  # SSH_ORIGINAL_COMMAND without --forced is ignored.
  if (($# == 1)) && [[ $1 == --forced ]]; then
    raw=${SSH_ORIGINAL_COMMAND-} forced=1
  else
    raw="$*" forced=0
  fi
  if ! parse_request "$raw" "$forced"; then
    # %q so a hostile request cannot put escape sequences into a terminal or
    # forge a line in the Actions log.
    log "rejected request: $(printf '%q' "${raw:0:128}")"
    log "usage: status | deploy <40-hex main sha>"
    syslog "rejected request from $(client)"
    result rejected
    exit "$EX_REJECTED"
  fi
  case $REQ_CMD in
    status) cmd_status ;;
    deploy) cmd_deploy "$REQ_SHA" "$REQ_ALLOW_DEX_RESTART" "$forced" ;;
  esac
}

# Sourcing (tests) defines the functions without running anything.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
