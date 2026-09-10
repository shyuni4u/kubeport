#!/usr/bin/env bash
# OCI Phase 2 부트스트랩 — VM 위에서 한 번 실행.
#
# What this does:
#   1. OS 방화벽 (iptables): 80/443 인그레스 + k3s pod/service CIDR 열고 persist.
#   2. k3s single-node 설치 (servicelb 유지 — klipper 가 호스트 80/443 → traefik).
#      BOOTSTRAP_OIDC_CLIENT_ID 가 있으면 k3s config 에 OIDC 신뢰도 설정.
#   3. kubectl/helm CLI 설치.
#   4. cert-manager 설치 + ClusterIssuer (LetsEncrypt prod) 생성.
#
# Prerequisites:
#   - Ubuntu 24.04 LTS (ARM, A1.Flex 의 OCI 공식 이미지).
#   - sudo 가능한 사용자 (ubuntu 기본 사용자).
#   - OCI Security List 에서 이미 80/443/22 inbound 허용됨 (cloud-side 방화벽).
#
# Usage:
#   scp deploy/oci/bootstrap.sh ubuntu@<public-ip>:~
#   ssh ubuntu@<public-ip>
#   sudo BOOTSTRAP_EMAIL=you@example.com bash bootstrap.sh
#   # 실제 배포까지 켜려면 (선택):
#   sudo BOOTSTRAP_EMAIL=you@example.com \
#        BOOTSTRAP_OIDC_CLIENT_ID=<google-client-id> bash bootstrap.sh
#   # k3s 는 고정 버전(K3S_PINNED)으로 깔린다 (#194). 복구 등으로 다른 버전이 필요할 때만:
#   sudo BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_K3S_VERSION=v1.xx.y+k3s1 bash bootstrap.sh
#   # 오버라이드 버전에는 그 태그의 install.sh 와 k3s 바이너리 sha256 을 함께 준다 (#221 — 내용으로 고정):
#   #   BOOTSTRAP_K3S_INSTALL_SHA256=$(curl -fsSL https://raw.githubusercontent.com/k3s-io/k3s/v1.xx.y%2Bk3s1/install.sh | sha256sum | cut -d' ' -f1)
#   #   BOOTSTRAP_K3S_BIN_SHA256=<릴리스 sha256sum-<arch>.txt 의 k3s(-arm64) 줄 — 자산 digest 와 대조>
#   #   (먼저 그 파일들을 확인하고 나서.) 이미 k3s 가 깔린 노드에서는 설치하지 않으므로 필요 없다.
#   # v1.30 미만은 거부, 지원 종료 마이너(K3S_MIN_SUPPORTED_MINOR 미만)는 BOOTSTRAP_K3S_ALLOW_EOL=1 일 때만.
#   # AuthenticationConfiguration apiVersion 은 apiserver 버전에서 고른다 (BOOTSTRAP_AUTH_API 로 덮을 수 있음).
#
# After this completes, run helm install separately (deploy/oci/README.md).

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "error: this script needs root (sudo bash bootstrap.sh)" >&2
  exit 1
fi

: "${BOOTSTRAP_EMAIL:?BOOTSTRAP_EMAIL env required (used for LetsEncrypt account)}"

# Pinned rather than whatever get.k3s.io calls stable on the day this runs (#194).
# k3s bundles Traefik, so an unpinned install silently changes the ingress in
# front of kubeport as well — including the entrypoint timeout defaults that
# bound how long a log stream can stay open. A VM rebuilt during recovery would
# otherwise come up on a k3s/Traefik pair nobody has run.
#
# This is what production runs (measured 2026-09-10: v1.36.3+k3s1, Traefik
# 3.7.8). Bump it in a commit of its own, together with docs/oci-prod-runbook.md
# §2. BOOTSTRAP_K3S_VERSION overrides it — say, to rebuild at a known older
# version — and an override is announced, never silent.
K3S_PINNED="v1.36.3+k3s1"
# The oldest Kubernetes minor upstream still patches, and the day that support
# ends (kubernetes.io/releases). This moves on its own schedule, not the pin's:
# raise both whenever a new Kubernetes minor comes out (about every 4 months).
K3S_MIN_SUPPORTED_MINOR=34
K3S_MIN_SUPPORTED_UNTIL="2026-10-27"
K3S_VERSION="${BOOTSTRAP_K3S_VERSION:-${K3S_PINNED}}"

# What bootstrap downloads and runs as root is pinned by content, not only by
# version (#221). A version tag names a release; it does not fix what the
# release serves. The script used to pipe https://get.k3s.io and helm's
# get-helm-3 from its main branch into a root shell, and the k3s binary was
# checked only against a sha256sum file from the same release — replace both
# assets and the check still passes. Each file below is now fetched from a
# release-tagged URL and checked against the sha256 written here before
# anything runs or is applied (Step 0). If upstream changes one, the hash stops
# matching and bootstrap stops — it never falls back to an unpinned URL.
#
# Not covered: container images. The cert-manager manifest and k3s's bundled
# components (traefik, coredns, ...) pull their images by tag at run time.
#
# Bump a version and its hashes in the same commit (docs/oci-prod-runbook.md §2):
#   k3s install.sh: curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/<ver with + as %2B>/install.sh" | sha256sum
#   k3s binary:     the k3s / k3s-arm64 lines of the release's sha256sum-<arch>.txt, cross-checked with the
#                   asset digest: gh api repos/k3s-io/k3s/releases/tags/<ver> --jq '.assets[]|.name+" "+.digest'
#   helm:           https://get.helm.sh/helm-<ver>-linux-<arch>.tar.gz.sha256sum (published next to the tarball)
#   cert-manager:   curl -fsSL https://github.com/cert-manager/cert-manager/releases/download/<ver>/cert-manager.yaml | sha256sum
K3S_INSTALL_SHA256_PINNED="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"  # install.sh @ v1.36.3+k3s1
K3S_BIN_SHA256_ARM64_PINNED="c9a209103f480f163b7c6a56f00862b4481927b284dc29a3716bb70d886691a8"  # k3s-arm64 @ v1.36.3+k3s1
K3S_BIN_SHA256_AMD64_PINNED="2f98a9f8fe5782479ee2d54e70a1b10a7f6fd4cae8d38ed3098452dc6eed76b5"  # k3s @ v1.36.3+k3s1
HELM_VERSION="v3.20.2"  # CI's helm (.github/workflows/helm.yml)
HELM_SHA256_ARM64="5ea2d6bc2cda3f8edf985e028809f5a9278f404fb8ab24044de9b7cb9b79a691"
HELM_SHA256_AMD64="258e830a9e613c8a7a302d6059b4bb3b9758f2f3e1bb8ea0d707ce10a9a72fea"
CERT_MANAGER_VERSION="v1.16.1"
CERT_MANAGER_SHA256="ad09a35d3dd404f98f4e16555b01b89bdf7a499932b4567f3e2eddb4ef3cab15"

# The minor of a k3s version string, or nothing when it is not one.
k3s_minor_of() {
  [[ "$1" =~ ^v1\.([0-9]+)\.[0-9]+\+k3s[0-9]+$ ]] && echo "$((10#${BASH_REMATCH[1]}))"
}

# Everything below is checked before anything on the host changes. The override
# used to go to the installer as given, so a typo or an old version installed
# quietly (security review of #206).
k3s_minor="$(k3s_minor_of "${K3S_VERSION}" || true)"
if [[ -z "${k3s_minor}" ]]; then
  echo "error: BOOTSTRAP_K3S_VERSION must look like v1.NN.P+k3sN (got ${K3S_VERSION})" >&2
  exit 1
fi
# Below 1.30 there is no structured authentication, which Step 2 writes and
# deploy/oci/k3s-auth-config.sh needs for the Dex demo IdP. No flag lifts this.
if (( k3s_minor < 30 )); then
  echo "error: k3s ${K3S_VERSION} predates structured authentication; use v1.30 or later" >&2
  exit 1
fi
# A minor upstream no longer patches is refused unless asked for by name, for a
# recovery that has to reproduce an old node. 1.30 above is where a feature
# starts, not where support ends.
if (( k3s_minor < K3S_MIN_SUPPORTED_MINOR )) && [[ "${BOOTSTRAP_K3S_ALLOW_EOL:-}" != 1 ]]; then
  echo "error: k3s ${K3S_VERSION} is past upstream end of life (oldest supported minor: 1.${K3S_MIN_SUPPORTED_MINOR}); set BOOTSTRAP_K3S_ALLOW_EOL=1 to install it anyway (recovery only)" >&2
  exit 1
fi
# Once that day passes, the floor above lets an unsupported minor through. Say
# so loudly rather than stop: this script is what a recovery runs, and failing
# it because of the date would bite at the worst moment.
if [[ "$(date -u +%F)" > "${K3S_MIN_SUPPORTED_UNTIL}" ]]; then
  echo "WARNING: K3S_MIN_SUPPORTED_MINOR=${K3S_MIN_SUPPORTED_MINOR} is stale (1.${K3S_MIN_SUPPORTED_MINOR} reached end of life ${K3S_MIN_SUPPORTED_UNTIL}); raise it in deploy/oci/bootstrap.sh" >&2
fi
if [[ "${K3S_VERSION}" != "${K3S_PINNED}" ]]; then
  echo "NOTE: BOOTSTRAP_K3S_VERSION=${K3S_VERSION} overrides the pinned ${K3S_PINNED}" >&2
fi

# A re-run leaves an installed k3s as it is (Step 2), so the apiserver that will
# read auth.yaml is the installed one, not K3S_VERSION.
installed=""
k3s_present=""
if command -v k3s >/dev/null 2>&1; then
  k3s_present=1
  installed="$(k3s --version 2>/dev/null | awk 'NR==1 {print $3}' || true)"
fi

# The CPU architecture picks the k3s binary and the helm tarball. Only a node
# that will install one of them needs a pinned build for it.
helm_present=""
command -v helm >/dev/null 2>&1 && helm_present=1
ARCH=""
if [[ -z "${k3s_present}" || -z "${helm_present}" ]]; then
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=amd64 ;;
    *)
      echo "error: no pinned k3s/helm build for $(uname -m); add its downloads and sha256 to bootstrap.sh" >&2
      exit 1
      ;;
  esac
fi

# Which k3s hashes Step 0 checks — the installer script and the binary. Only a
# node that will install k3s needs them. The pin's hashes come with the pin; an
# override has none in this file, so it must bring both — otherwise it would run
# whatever the tag serves, which is the unpinned install this replaced (#221).
K3S_INSTALL_SHA256=""; K3S_BIN_SHA256=""; K3S_BIN_ASSET=""
if [[ -z "${k3s_present}" ]]; then
  if [[ "${ARCH}" == arm64 ]]; then K3S_BIN_ASSET=k3s-arm64; pinned_bin="${K3S_BIN_SHA256_ARM64_PINNED}"
  else K3S_BIN_ASSET=k3s; pinned_bin="${K3S_BIN_SHA256_AMD64_PINNED}"; fi
  if [[ "${K3S_VERSION}" == "${K3S_PINNED}" ]]; then
    K3S_INSTALL_SHA256="${K3S_INSTALL_SHA256_PINNED}"
    K3S_BIN_SHA256="${pinned_bin}"
    for given in INSTALL:"${BOOTSTRAP_K3S_INSTALL_SHA256:-}":"${K3S_INSTALL_SHA256}" BIN:"${BOOTSTRAP_K3S_BIN_SHA256:-}":"${K3S_BIN_SHA256}"; do
      IFS=: read -r which value pinned <<<"${given}"
      if [[ -n "${value}" && "${value}" != "${pinned}" ]]; then
        echo "error: BOOTSTRAP_K3S_${which}_SHA256 differs from the pinned hash for ${K3S_PINNED}; leave it unset, or change the pin in bootstrap.sh" >&2
        exit 1
      fi
    done
  else
    K3S_INSTALL_SHA256="${BOOTSTRAP_K3S_INSTALL_SHA256:-}"
    K3S_BIN_SHA256="${BOOTSTRAP_K3S_BIN_SHA256:-}"
    if [[ ! "${K3S_INSTALL_SHA256}" =~ ^[0-9a-f]{64}$ || ! "${K3S_BIN_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
      echo "error: BOOTSTRAP_K3S_VERSION=${K3S_VERSION} needs BOOTSTRAP_K3S_INSTALL_SHA256 and BOOTSTRAP_K3S_BIN_SHA256 — the sha256 (64 lowercase hex) of" >&2
      echo "  https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION//+/%2B}/install.sh (after reading it) and of" >&2
      echo "  https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION//+/%2B}/${K3S_BIN_ASSET} (check it against the release's asset digest)" >&2
      exit 1
    fi
  fi
fi

HELM_ARCH=""; HELM_SHA256=""
if [[ -z "${helm_present}" ]]; then
  HELM_ARCH="${ARCH}"
  if [[ "${ARCH}" == arm64 ]]; then HELM_SHA256="${HELM_SHA256_ARM64}"; else HELM_SHA256="${HELM_SHA256_AMD64}"; fi
fi
auth_minor="$(k3s_minor_of "${installed}" || true)"
auth_minor="${auth_minor:-${k3s_minor}}"
# AuthenticationConfiguration is apiserver.config.k8s.io/v1 from k8s 1.34 and
# v1beta1 from 1.30. v1 on an older apiserver does not exist: it never starts,
# and the node-Ready wait fails without saying why. So the default follows the
# apiserver, and v1 is refused below 1.34 (the rule deploy/oci/k3s-auth-config.sh
# applies too). BOOTSTRAP_AUTH_API still overrides.
if (( auth_minor >= 34 )); then
  auth_api_default="apiserver.config.k8s.io/v1"
else
  auth_api_default="apiserver.config.k8s.io/v1beta1"
fi
AUTH_API="${BOOTSTRAP_AUTH_API:-${auth_api_default}}"

# Existing auth config is never overwritten: deploy/oci/k3s-auth-config.sh adds
# the Dex issuer to the same files, and replacing them with the Google-only form
# removed that trust silently — the next k3s restart turned every demo cluster
# call into a 401 (security review of #206). Keeping them is only right when they
# already say what this run asks for, so their content is checked here, before
# the host changes, rather than a warning scrolling past mid-run.
AUTH_FILE=/etc/rancher/k3s/auth.yaml
CFG_FILE=/etc/rancher/k3s/config.yaml
skip_auth_write=""

# Both existing files are read as values, never as raw text: a comment can hold
# anything — the old client ID, the new one, a different argument — and text
# matching let it satisfy the check (codex review, three times over). So every
# line goes through strip() first, which drops a whole comment line or a `#`
# that follows whitespace outside quotes, and values through unquote(). What
# the two parsers below cannot read as the layout this script and
# k3s-auth-config.sh write is reported, and a report refuses the files.
YAML_AWK_LIB='
function strip(s,   i, c, q, out, prev) {
  q = ""; out = ""; prev = " "
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (q != "") { out = out c; if (c == q) q = ""; prev = c; continue }
    if (c == "\"" || c == "\047") { q = c; out = out c; prev = c; continue }
    if (c == "#" && (prev == " " || prev == "\t")) break
    out = out c; prev = c
  }
  sub(/[ \t]+$/, "", out)
  return out
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function unquote(v,   f) {
  v = trim(v); f = substr(v, 1, 1)
  if (length(v) >= 2 && (f == "\"" || f == "\047") && substr(v, length(v), 1) == f) return substr(v, 2, length(v) - 2)
  return v
}
'

# k3s_config_entries <config.yaml> — "arg <value>" for each active entry of a
# block-list kube-apiserver-arg, and a line starting "!" for anything else that
# is set: another top-level key, the key in scalar or flow form, or a line
# outside the list.
k3s_config_entries() {
  awk "${YAML_AWK_LIB}"'
    { line = strip($0) }
    line == "" { next }
    line ~ /^kube-apiserver-arg:$/ { inargs = 1; next }
    line ~ /^[^ \t]/ { inargs = 0; k = line; sub(/:.*/, "", k); print "!key " k; next }
    inargs && line ~ /^[ \t]+-[ \t]+/ { v = line; sub(/^[ \t]+-[ \t]+/, "", v); print "arg " unquote(v); next }
    { print "!line " trim(line) }
  ' "$1" 2>/dev/null
}

# auth_facts <auth.yaml> <issuer-url> — one fact per line:
#   top <key> <value>   each top-level key (value unquoted, empty for a block)
#   found               the jwt entry whose url is <issuer-url> exists
#   aud <client>        each element of that entry's audiences list
#   claim <v> / prefix <v>   that entry's username mapping
#   other <key>         any other key that entry sets
#   bad <reason>        a line in a shape this cannot read as values
#
# Each jwt entry is read whole before its url decides whether it is the one
# asked for. Deciding on the url line and reading only what followed skipped
# any key written above it — a discoveryURL or certificateAuthority placed
# before url passed as "bootstrap writes this" (#236). The entry starts at a
# list dash at the jwt list's own indentation; a dash deeper than that is a
# nested list, which neither script writes.
auth_facts() {
  awk -v want="$2" "${YAML_AWK_LIB}"'
    function items(inner, arr,   n, i, parts) {
      n = split(inner, parts, ","); for (i = 1; i <= n; i++) arr[i] = trim(parts[i]); return n
    }
    function emit(s) { buf = buf s "\n" }
    function flush() {
      if (inentry && entryurl == want) {
        if (found) print "bad more than one jwt entry for this issuer"
        found = 1; print "found"; printf "%s", buf
      }
      inentry = 0; entryurl = ""; sawurl = 0; buf = ""
    }
    { line = strip($0) }
    line == "" { next }
    line ~ /^[^ \t-]/ {
      flush(); jwtdash = ""
      k = line; sub(/:.*/, "", k); v = line; if (index(v, ":")) sub(/^[^:]*:/, "", v); else v = ""
      print "top " k " " unquote(v); next
    }
    line ~ /^[ \t]*-([ \t]|$)/ {
      ind = line; sub(/-.*/, "", ind); d = length(ind)
      if (jwtdash == "") jwtdash = d
      if (d != jwtdash) {
        if (inentry) emit("bad nested list inside an issuer entry: " trim(line))
        else print "bad line outside a jwt issuer entry: " trim(line)
        next
      }
      flush(); inentry = 1
      sub(/^[ \t]*-[ \t]*/, "", line)
      if (line == "") next
      line = "    " line
    }
    !inentry { print "bad line outside a jwt issuer entry: " trim(line); next }
    line ~ /^[ \t]*(issuer|claimMappings):$/ { next }
    line ~ /^[ \t]*url:/ {
      v = line; sub(/^[ \t]*url:/, "", v)
      if (sawurl) emit("bad more than one url in an issuer entry")
      sawurl = 1; entryurl = unquote(v)
      next
    }
    line ~ /^[ \t]*audiences:/ {
      v = line; sub(/^[ \t]*audiences:/, "", v); v = trim(v)
      if (v !~ /^\[.*\]$/) { emit("bad audiences is not a one-line [list]"); next }
      n = items(substr(v, 2, length(v) - 2), a)
      for (i = 1; i <= n; i++) if (a[i] != "") emit("aud " unquote(a[i]))
      next
    }
    line ~ /^[ \t]*username:/ {
      v = line; sub(/^[ \t]*username:/, "", v); v = trim(v)
      if (v !~ /^\{.*\}$/) { emit("bad username is not a one-line {map}"); next }
      n = items(substr(v, 2, length(v) - 2), a)
      for (i = 1; i <= n; i++) {
        if (a[i] == "") continue
        if (!index(a[i], ":")) { emit("bad username entry without a value: " a[i]); continue }
        kk = a[i]; sub(/:.*/, "", kk); kk = unquote(kk)
        vv = a[i]; sub(/^[^:]*:/, "", vv); vv = unquote(vv)
        if (kk == "claim") emit("claim " vv)
        else if (kk == "prefix") emit("prefix " vv)
        else emit("other username." kk)
      }
      next
    }
    { k = trim(line); sub(/:.*/, "", k); emit("other " k) }
    END { flush() }
  ' "$1" 2>/dev/null
}
if [[ -n "${BOOTSTRAP_OIDC_CLIENT_ID:-}" ]]; then
  if (( auth_minor < 30 )); then
    echo "error: installed k3s ${installed} (k8s 1.${auth_minor}) predates structured authentication; upgrade k3s first (a restart, so ask first — runbook §2)" >&2
    exit 1
  fi
  # Whether this apiserver can read AUTH_API at all is its own check, before the
  # existing files are compared with it — so a file written for the version
  # this run selects passes, and a version the apiserver lacks is named as such.
  if [[ "${AUTH_API}" == "apiserver.config.k8s.io/v1" ]] && (( auth_minor < 34 )); then
    echo "error: k8s 1.${auth_minor} has no ${AUTH_API}; use BOOTSTRAP_AUTH_API=apiserver.config.k8s.io/v1beta1 or leave it unset" >&2
    exit 1
  fi
  if [[ -e "${AUTH_FILE}" || -e "${CFG_FILE}" ]]; then
    problems=()
    # The files are kept only if what k3s will actually load is what Step 2
    # would write — one post-condition, checked on both files, instead of
    # looking for the right text somewhere in them (codex review: a
    # commented-out argument or one naming auth.yaml.bak also contained it).
    #
    # config.yaml: the only key is a block list kube-apiserver-arg, whose one
    # active entry is exactly authentication-config=<the auth.yaml checked
    # below> — the file both scripts write. k3s also merges config.yaml.d/*.yaml,
    # so a drop-in that passes apiserver arguments is a difference as well.
    cfg_args=(); cfg_other=()
    while IFS= read -r line; do
      case "${line}" in
        "arg "*) cfg_args+=("${line#arg }") ;;
        *) cfg_other+=("${line}") ;;
      esac
    done < <(k3s_config_entries "${CFG_FILE}" || true)
    if [[ ! -f "${CFG_FILE}" ]]; then
      problems+=("${CFG_FILE} is missing, so k3s would not load ${AUTH_FILE}")
    elif (( ${#cfg_other[@]} )); then
      problems+=("${CFG_FILE} has more than the kube-apiserver-arg list bootstrap writes: ${cfg_other[*]}")
    elif (( ${#cfg_args[@]} != 1 )) || [[ "${cfg_args[0]}" != "authentication-config=${AUTH_FILE}" ]]; then
      problems+=("${CFG_FILE}'s active kube-apiserver-arg entries are [${cfg_args[*]}]; bootstrap writes exactly authentication-config=${AUTH_FILE}")
    fi
    for dropin in "${CFG_FILE}.d"/*.yaml; do
      [[ -f "${dropin}" ]] || continue
      grep -q 'kube-apiserver-arg' "${dropin}" 2>/dev/null &&
        problems+=("${dropin} also passes kube-apiserver-arg, which k3s merges into ${CFG_FILE}")
    done
    # auth.yaml, as values:
    #   - top level: apiVersion is AUTH_API (not the default — an override this
    #     script accepted and wrote must pass on the rerun), kind is
    #     AuthenticationConfiguration, jwt is a block list, and nothing else —
    #     an `anonymous:` setting there changes what the apiserver accepts;
    #   - the requested issuer's own entry (not the whole file, where the Dex
    #     entry could supply a match) holds everything Step 2 would write:
    #     audiences exactly [BOOTSTRAP_OIDC_CLIENT_ID], the username claim, an
    #     empty prefix, and no other mapping (neither script writes groups).
    # Entries for other issuers (Dex) are not compared, and are kept.
    want_issuer="${BOOTSTRAP_OIDC_ISSUER:-https://accounts.google.com}"
    want_claim="${BOOTSTRAP_OIDC_USERNAME_CLAIM:-email}"
    top_api="<unset>"; top_kind="<unset>"; top_jwt="<unset>"; top_other=()
    e_found=""; e_aud=(); e_claim="<unset>"; e_prefix="<unset>"; e_other=(); e_bad=()
    while IFS= read -r line; do
      case "${line}" in
        "top apiVersion "*) top_api="${line#top apiVersion }" ;;
        "top kind "*) top_kind="${line#top kind }" ;;
        "top jwt "*) top_jwt="${line#top jwt }" ;;
        "top "*) key="${line#top }"; top_other+=("${key%% *}") ;;
        found) e_found=1 ;;
        "aud "*) e_aud+=("${line#aud }") ;;
        "claim "*) e_claim="${line#claim }" ;;
        "prefix "*) e_prefix="${line#prefix }" ;;
        "other "*) e_other+=("${line#other }") ;;
        "bad "*) e_bad+=("${line#bad }") ;;
      esac
    done < <(auth_facts "${AUTH_FILE}" "${want_issuer}" || true)
    if [[ ! -f "${AUTH_FILE}" ]]; then
      problems+=("${AUTH_FILE} is missing")
    else
      [[ "${top_api}" == "${AUTH_API}" ]] ||
        problems+=("${AUTH_FILE} is apiVersion ${top_api}, not ${AUTH_API}, which this run selects")
      [[ "${top_kind}" == "AuthenticationConfiguration" ]] ||
        problems+=("${AUTH_FILE} is not a kind: AuthenticationConfiguration")
      [[ -z "${top_jwt}" ]] ||
        problems+=("${AUTH_FILE} has no jwt block list, the layout bootstrap and k3s-auth-config.sh write")
      (( ${#top_other[@]} == 0 )) ||
        problems+=("${AUTH_FILE} also sets ${top_other[*]} at the top, which bootstrap does not write")
      for reason in "${e_bad[@]}"; do
        problems+=("${AUTH_FILE}: ${reason}")
      done
      if [[ -z "${e_found}" ]]; then
        problems+=("${AUTH_FILE} has no jwt entry for issuer ${want_issuer} (BOOTSTRAP_OIDC_ISSUER)")
      else
        listed=""
        for a in "${e_aud[@]}"; do [[ "${a}" == "${BOOTSTRAP_OIDC_CLIENT_ID}" ]] && listed=1; done
        if [[ -z "${listed}" ]]; then
          problems+=("the ${want_issuer} entry does not list BOOTSTRAP_OIDC_CLIENT_ID as an audience (it lists [${e_aud[*]}])")
        elif (( ${#e_aud[@]} != 1 )); then
          problems+=("the ${want_issuer} entry lists audiences [${e_aud[*]}], and bootstrap writes only BOOTSTRAP_OIDC_CLIENT_ID")
        fi
        [[ "${e_claim}" == "${want_claim}" ]] ||
          problems+=("the ${want_issuer} entry maps usernames from claim '${e_claim}', and this run asks for '${want_claim}' (BOOTSTRAP_OIDC_USERNAME_CLAIM)")
        [[ -z "${e_prefix}" ]] ||
          problems+=("the ${want_issuer} entry gives usernames the prefix '${e_prefix}', and bootstrap writes none")
        (( ${#e_other[@]} == 0 )) ||
          problems+=("the ${want_issuer} entry also sets ${e_other[*]}, which bootstrap does not write")
      fi
    fi
    if (( ${#problems[@]} )); then
      echo "error: bootstrap keeps an existing k3s auth config as it is, and this one does not match the run:" >&2
      printf '  - %s\n' "${problems[@]}" >&2
      echo "  Fix it by hand, or re-run deploy/oci/k3s-auth-config.sh, which writes Google and Dex together." >&2
      exit 1
    fi
    skip_auth_write=1
  fi
fi

echo "== Step 0/4: download and verify the pinned installers =="
# Before the host changes: a changed or unreachable artifact stops the run here,
# with nothing installed and the firewall untouched.
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# fetch_verified <url> <sha256> <dest> — download, then keep the file only if
# its sha256 is the pinned one. A mismatch removes it and stops; there is no
# fallback to an unpinned source.
fetch_verified() {
  local url="$1" want="$2" dest="$3" got
  # The file check as well as curl's status: a download that reports success
  # but leaves nothing must fail here with this message, not in sha256sum.
  if ! curl -fsSL --retry 3 --max-time 180 -o "${dest}" "${url}" || [[ ! -s "${dest}" ]]; then
    rm -f "${dest}"
    echo "error: could not download ${url}; nothing was installed" >&2
    exit 1
  fi
  got="$(sha256sum "${dest}" | awk '{print $1}')"
  if [[ "${got}" != "${want}" ]]; then
    rm -f "${dest}"
    echo "error: ${url} is not the pinned file (sha256 ${got}, pinned ${want})." >&2
    echo "  Upstream changed it, or the download was tampered with. Nothing was run or installed from it." >&2
    echo "  Read the new file before trusting it, then update the pin in deploy/oci/bootstrap.sh (runbook §2)." >&2
    exit 1
  fi
  echo "  verified $(basename "${dest}") (${got})"
}

if [[ -z "${k3s_present}" ]]; then
  fetch_verified "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION//+/%2B}/install.sh" \
    "${K3S_INSTALL_SHA256}" "${WORK}/k3s-install.sh"
  fetch_verified "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION//+/%2B}/${K3S_BIN_ASSET}" \
    "${K3S_BIN_SHA256}" "${WORK}/k3s"
fi
if [[ -n "${HELM_ARCH}" ]]; then
  fetch_verified "https://get.helm.sh/helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz" \
    "${HELM_SHA256}" "${WORK}/helm.tar.gz"
fi
# Only when Step 4 will apply it: a re-run on a node that already has
# cert-manager must not fail here because GitHub is unreachable.
if [[ -z "${k3s_present}" ]] || ! k3s kubectl get ns cert-manager >/dev/null 2>&1; then
  fetch_verified "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" \
    "${CERT_MANAGER_SHA256}" "${WORK}/cert-manager.yaml"
fi

echo
echo "== Step 1/4: OS firewall (iptables) — open 80/443 =="
# OCI Ubuntu images ship with a default INPUT policy that DROPs most inbound
# traffic past SSH. Insert ACCEPT rules above the catch-all REJECT.
# Idempotent: -C checks if the rule already exists.
ensure_rule() {
  local port="$1"
  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "${port}" -j ACCEPT 2>/dev/null; then
    # Insert at position 1 — safe regardless of how many rules already exist
    # (a hardcoded higher index can fail with "Index of insertion too large"
    # on a fresh image). Order vs the catch-all REJECT doesn't matter because
    # the catch-all sits at the end of the chain.
    iptables -I INPUT 1 -p tcp -m state --state NEW -m tcp --dport "${port}" -j ACCEPT
    echo "  inserted ACCEPT for ${port}/tcp"
  else
    echo "  rule already present for ${port}/tcp"
  fi
}
ensure_rule 80
ensure_rule 443

# k3s pod (10.42.0.0/16) and service (10.43.0.0/16) CIDRs must be allowed to
# reach the host: the apiserver runs in the host netns (:6443), and pod ->
# apiserver traffic hits the host INPUT chain. Without these, the catch-all
# REJECT drops it and EVERY release deploy fails (backend can't reach the
# k8s API). This is the root cause the earlier manual fix addressed — see
# deploy/oci/README.md §7.2.
ensure_cidr() {
  local cidr="$1"
  if ! iptables -C INPUT -s "${cidr}" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -s "${cidr}" -j ACCEPT
    echo "  inserted ACCEPT from ${cidr}"
  else
    echo "  rule already present for ${cidr}"
  fi
}
ensure_cidr 10.42.0.0/16
ensure_cidr 10.43.0.0/16

# Persist across reboots
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent netfilter-persistent
netfilter-persistent save
echo "  iptables rules saved"

echo
echo "== Step 2/4: k3s single-node install =="
# Optionally trust an external OIDC provider (e.g. Google) so end-user tokens
# work for k8s RBAC — the backend forwards the user's id_token to the apiserver.
# Enable by exporting BOOTSTRAP_OIDC_CLIENT_ID (and optionally _ISSUER). Written
# BEFORE install so k3s picks it up on first start (no restart needed).
# Uses a structured AuthenticationConfiguration (Google issuer only) rather
# than --oidc-* flags: the two forms cannot coexist, and adding the Dex demo
# IdP later (deploy/oci/k3s-auth-config.sh) requires the structured form, so
# bootstrap writes it directly to avoid a config-format migration afterwards.
# NB: values MUST be quoted — a trailing ':' in a value makes YAML parse the list
# item as a map and k3s dies with "unknown flag". See deploy/oci/README.md §7.1.
# The apiVersion is AUTH_API, chosen from the apiserver version at the top.
# Existing files were checked there and are kept (skip_auth_write) — they may
# carry the Dex trust k3s-auth-config.sh adds.
if [[ -n "${BOOTSTRAP_OIDC_CLIENT_ID:-}" && -n "${skip_auth_write}" ]]; then
  echo "  /etc/rancher/k3s/auth.yaml + config.yaml already trust this client; leaving them unchanged"
elif [[ -n "${BOOTSTRAP_OIDC_CLIENT_ID:-}" ]]; then
  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/auth.yaml <<YAML
apiVersion: ${AUTH_API}
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: ${BOOTSTRAP_OIDC_ISSUER:-https://accounts.google.com}
      audiences: ["${BOOTSTRAP_OIDC_CLIENT_ID}"]
    claimMappings:
      username: { claim: "${BOOTSTRAP_OIDC_USERNAME_CLAIM:-email}", prefix: "" }
YAML
  cat > /etc/rancher/k3s/config.yaml <<YAML
kube-apiserver-arg:
  - "authentication-config=/etc/rancher/k3s/auth.yaml"
YAML
  echo "  wrote /etc/rancher/k3s/auth.yaml + config.yaml (Google structured auth enabled)"
  echo "  Dex demo IdP trust is added later via deploy/oci/k3s-auth-config.sh (needs Dex ingress up first)"
fi

# K3S_VERSION is the pin, or the override checked at the top of this script.
if ! command -v k3s >/dev/null 2>&1; then
  # Keep the bundled klipper servicelb ENABLED: it is what binds host ports
  # 80/443 and forwards them to the traefik LoadBalancer Service. Disabling it
  # (as an earlier version did) leaves traefik's Service EXTERNAL-IP <pending>
  # and nothing listening on the host — traefik does NOT self-bind hostPorts.
  # traefik is the only LB Service here, so there is no port contention.
  # --write-kubeconfig-mode 644: lets non-root user read kubeconfig.
  # The binary and installer verified in Step 0 — not https://get.k3s.io (#221).
  # The binary goes in first and the installer only sets up the service around
  # it (INSTALL_K3S_SKIP_DOWNLOAD=binary): left to itself, install.sh would fetch
  # the binary again and check it against the release's own sha256sum file.
  #
  # env -u: install.sh reads INSTALL_K3S_PR/COMMIT before VERSION, and
  # ARTIFACT_URL/GITHUB_URL move where it downloads from. Inherited from the
  # operator's environment (sudo -E), they would silently replace what Step 0
  # verified.
  install -m 0755 -o root -g root "${WORK}/k3s" /usr/local/bin/k3s
  env -u INSTALL_K3S_PR -u INSTALL_K3S_COMMIT -u INSTALL_K3S_CHANNEL -u INSTALL_K3S_CHANNEL_URL \
      -u INSTALL_K3S_ARTIFACT_URL -u INSTALL_K3S_BIN_DIR -u INSTALL_K3S_BIN_DIR_READ_ONLY -u GITHUB_URL \
      INSTALL_K3S_SKIP_DOWNLOAD=binary INSTALL_K3S_VERSION="${K3S_VERSION}" \
      INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" \
      sh "${WORK}/k3s-install.sh"
  echo "  k3s ${K3S_VERSION} installed"
else
  # An existing install is left as it is. Changing the k3s version restarts
  # the control plane, which is a decision for a person (CLAUDE.md "사용자에게
  # 먼저 묻는 것"), not a side effect of re-running bootstrap. Say when it
  # differs from the pin, so a re-run on an old VM does not read as "on the
  # pinned version". `installed` was read at the top.
  if [[ "${installed}" == "${K3S_VERSION}" ]]; then
    echo "  k3s ${installed} already installed (matches the pin), skipping"
  else
    echo "  WARNING: k3s ${installed:-of unknown version} is installed, but this script pins ${K3S_VERSION}; leaving it unchanged" >&2
  fi
  installed_minor="$(k3s_minor_of "${installed}" || true)"
  if [[ -n "${installed_minor}" ]] && (( installed_minor < K3S_MIN_SUPPORTED_MINOR )); then
    echo "  WARNING: the installed k8s 1.${installed_minor} is past upstream end of life; upgrading it restarts k3s, so it needs approval (runbook §2)" >&2
  fi
fi

# Wait for the node to be Ready (90s cap — k3s normally needs 10–30s on A1)
echo "  waiting for k3s node Ready..."
ready=false
for i in {1..30}; do
  if k3s kubectl get nodes 2>/dev/null | grep -q ' Ready '; then
    ready=true
    break
  fi
  sleep 3
done
if ! $ready; then
  echo "error: k3s node did not reach Ready within 90s. Check: systemctl status k3s" >&2
  exit 1
fi
echo "  k3s node Ready"

# Make kubectl available to the ubuntu user without sudo
mkdir -p /home/ubuntu/.kube
cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/.kube/config
chown -R ubuntu:ubuntu /home/ubuntu/.kube
chmod 600 /home/ubuntu/.kube/config

echo
echo "== Step 3/4: helm CLI =="
if [[ -n "${HELM_ARCH}" ]]; then
  # The release tarball verified in Step 0, instead of running get-helm-3 from
  # helm's main branch (#221).
  tar -xzf "${WORK}/helm.tar.gz" -C "${WORK}"
  install -m 0755 "${WORK}/linux-${HELM_ARCH}/helm" /usr/local/bin/helm
  echo "  helm ${HELM_VERSION} installed"
else
  echo "  helm already installed, skipping"
fi

echo
echo "== Step 4/4: cert-manager + LetsEncrypt ClusterIssuer =="
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

if ! kubectl get ns cert-manager >/dev/null 2>&1; then
  # The manifest verified in Step 0 (#221).
  kubectl apply -f "${WORK}/cert-manager.yaml"
fi
echo "  waiting for cert-manager to be Available..."
kubectl wait --for=condition=Available --timeout=180s deploy -n cert-manager --all
echo "  cert-manager Ready"

# The cert-manager webhook needs a few extra seconds for its TLS bootstrap
# even after the Deployment is Available. Apply with retries instead of a
# blind sleep — the failure mode is a transient "failed calling webhook"
# error that disappears once the webhook's TLS handshake works.
echo "  applying ClusterIssuer..."
issuer_yaml=$(cat <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    email: ${BOOTSTRAP_EMAIL}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: traefik
YAML
)
applied=false
for i in {1..15}; do
  if echo "$issuer_yaml" | kubectl apply -f - 2>/dev/null; then
    applied=true
    break
  fi
  echo "  webhook not ready yet, retrying ($i/15)..."
  sleep 4
done
if ! $applied; then
  echo "error: ClusterIssuer apply failed after 60s of retries" >&2
  exit 1
fi

# Verify the issuer becomes Ready (ACME account registration)
echo "  waiting for ClusterIssuer Ready..."
ready=false
for i in {1..30}; do
  if kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q True; then
    ready=true
    break
  fi
  sleep 2
done
if ! $ready; then
  echo "error: ClusterIssuer did not reach Ready within 60s." >&2
  echo "  Check: kubectl describe clusterissuer letsencrypt-prod" >&2
  exit 1
fi
echo "  ClusterIssuer Ready"

echo
echo "== Bootstrap complete =="
echo
echo "Next steps (from your laptop):"
echo "  1. Confirm DNS: dig +short <your-host>  # should return this VM public IP"
echo "  2. Run helm install (see deploy/oci/README.md)"
echo
echo "Helpful commands on this VM:"
echo "  kubectl get pods -A"
echo "  kubectl get clusterissuer"
echo "  helm list -A"
