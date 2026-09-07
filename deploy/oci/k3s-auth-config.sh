#!/usr/bin/env bash
# deploy/oci/k3s-auth-config.sh — switch k3s apiserver from --oidc-* flags to a
# structured AuthenticationConfiguration trusting Google + Dex.
# Run ON THE VM as a sudoer. Idempotent. ROLLBACK=1 restores config.yaml.bak.
set -euo pipefail

CFG=/etc/rancher/k3s/config.yaml
AUTH=/etc/rancher/k3s/auth.yaml
DEX_ISSUER="${DEX_ISSUER:-https://dex.kubeport.enzo.kr}"
DEX_CLIENT_ID="${DEX_CLIENT_ID:-kubeport-demo}"
DEX_USERNAME_PREFIX="${DEX_USERNAME_PREFIX:-dex:}"

restart_and_verify() {
  sudo systemctl restart k3s
  for i in $(seq 1 30); do
    if sudo k3s kubectl get --raw=/readyz 2>/dev/null | grep -q ok; then echo "apiserver ready"; return 0; fi
    sleep 2
  done
  return 1
}

if [[ "${ROLLBACK:-0}" == "1" ]]; then
  echo "rolling back to ${CFG}.bak"
  sudo cp "${CFG}.bak" "$CFG"
  restart_and_verify
  exit $?
fi

: "${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID is required}"

# If config.yaml already exists and carries keys other than kube-apiserver-arg,
# abort rather than silently dropping them — the operator must merge by hand.
if [[ -f "$CFG" ]]; then
  if sudo grep -qvE '^(kube-apiserver-arg:|[[:space:]]*-[[:space:]]|[[:space:]]*#|[[:space:]]*$)' "$CFG"; then
    echo "error: ${CFG} has keys other than kube-apiserver-arg — merge them into this script's heredoc manually before running" >&2
    sudo cat "$CFG" >&2
    exit 1
  fi
fi

# Structured auth is GA (v1) on k8s >= 1.34, beta (v1beta1) on 1.30–1.33.
MINOR=$(sudo k3s kubectl version -o json | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["serverVersion"]["minor"].rstrip("+")))')
if (( MINOR >= 34 )); then API=apiserver.config.k8s.io/v1; elif (( MINOR >= 30 )); then API=apiserver.config.k8s.io/v1beta1; else echo "k8s 1.$MINOR too old for structured auth"; exit 1; fi

# The apiserver must be able to fetch ${DEX_ISSUER}/.well-known/openid-configuration.
curl -fsS "${DEX_ISSUER}/.well-known/openid-configuration" >/dev/null || { echo "dex discovery unreachable from the node"; exit 1; }

sudo cp -n "$CFG" "${CFG}.bak" 2>/dev/null || true

# ⚠️ values MUST be quoted — a trailing ':' in a value makes YAML parse the
# list item as a map and k3s dies with "unknown flag". See README §7.1.
sudo tee "$AUTH" >/dev/null <<EOF
apiVersion: ${API}
kind: AuthenticationConfiguration
jwt:
  - issuer:
      url: https://accounts.google.com
      audiences: ["${GOOGLE_CLIENT_ID}"]
    claimMappings:
      username: { claim: email, prefix: "" }
  - issuer:
      url: ${DEX_ISSUER}
      audiences: ["${DEX_CLIENT_ID}"]
    claimMappings:
      username: { claim: email, prefix: "${DEX_USERNAME_PREFIX}" }
EOF

# Replace ALL oidc-* args — they cannot coexist with authentication-config.
sudo tee "$CFG" >/dev/null <<EOF
kube-apiserver-arg:
  - "authentication-config=${AUTH}"
EOF

if restart_and_verify; then
  echo "structured auth active: Google + ${DEX_ISSUER}"
  echo "wrote ${AUTH}"
  echo "verify with: kubectl --token <token> auth whoami"
else
  echo "apiserver did not become ready — rolling back"
  sudo cp "${CFG}.bak" "$CFG"; restart_and_verify; exit 1
fi
