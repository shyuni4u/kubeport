#!/usr/bin/env bash
# .github/workflows/oci-a1-capacity-poll.yml 가 필요로 하는 GitHub secrets 를
# 로컬 OCI 설정 (~/.oci/, ~/oci-capacity-retry/config.env, ~/.ssh/oci_kubeport.pub — 없으면 옛 이름 oci_kuberport.pub) 에서
# 뽑아 한 번에 업로드. 한 번만 돌리면 됨.
#
# 전제:
#   - gh CLI 인증됨 (gh auth status)
#   - 현재 디렉터리가 kubeport repo 안 (혹은 -R shyuni4u/kubeport 직접 지정)
#   - ~/.oci/config 의 [DEFAULT] 프로필 사용
set -euo pipefail

OCI_CONFIG="$HOME/.oci/config"
OCI_KEY="$HOME/.oci/oci_api_key.pem"
RETRY_CONFIG="$HOME/oci-capacity-retry/config.env"
# The SSH key pair was originally created as `oci_kuberport` (historical
# typo). Prefer the corrected name when present, fall back to the legacy one.
SSH_PUB="$HOME/.ssh/oci_kubeport.pub"
[[ -f "$SSH_PUB" ]] || SSH_PUB="$HOME/.ssh/oci_kuberport.pub"

for f in "$OCI_CONFIG" "$OCI_KEY" "$RETRY_CONFIG" "$SSH_PUB"; do
  [[ -f "$f" ]] || { echo "missing: $f" >&2; exit 1; }
done

get_oci_field() {
  awk -F= -v key="$1" '
    /^\[DEFAULT\]/ { in_default = 1; next }
    /^\[/ { in_default = 0 }
    in_default && $1 == key { sub(/^[[:space:]]+/, "", $2); print $2; exit }
  ' "$OCI_CONFIG"
}

# shellcheck source=/dev/null
source "$RETRY_CONFIG"

set_secret() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    echo "skip $name (empty)" >&2
    return
  fi
  printf '%s' "$value" | gh secret set "$name"
  echo "set $name"
}

set_secret OCI_USER_OCID     "$(get_oci_field user)"
set_secret OCI_TENANCY_OCID  "$(get_oci_field tenancy)"
set_secret OCI_REGION        "$(get_oci_field region)"
set_secret OCI_FINGERPRINT   "$(get_oci_field fingerprint)"
gh secret set OCI_API_KEY_PEM           < "$OCI_KEY"; echo "set OCI_API_KEY_PEM"
gh secret set OCI_SSH_AUTHORIZED_KEY    < "$SSH_PUB"; echo "set OCI_SSH_AUTHORIZED_KEY"
set_secret OCI_COMPARTMENT_ID "$OCI_COMPARTMENT_ID"
set_secret OCI_AD_NAME        "$OCI_AD_NAME"
set_secret OCI_SUBNET_ID      "$OCI_SUBNET_ID"
set_secret OCI_IMAGE_ID       "$OCI_IMAGE_ID"

echo
echo "Done. Verify with: gh secret list"
