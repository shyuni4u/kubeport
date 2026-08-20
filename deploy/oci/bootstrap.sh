#!/usr/bin/env bash
# OCI Phase 2 부트스트랩 — VM 위에서 한 번 실행.
#
# What this does:
#   1. OS 방화벽 (iptables) 80/443 인그레스 열고 persist.
#   2. k3s single-node 설치 (servicelb 비활성 — traefik 가 hostPort 로 잡음).
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
#
# After this completes, run helm install separately (deploy/oci/README.md).

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "error: this script needs root (sudo bash bootstrap.sh)" >&2
  exit 1
fi

: "${BOOTSTRAP_EMAIL:?BOOTSTRAP_EMAIL env required (used for LetsEncrypt account)}"

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

# Persist across reboots
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent netfilter-persistent
netfilter-persistent save
echo "  iptables rules saved"

echo
echo "== Step 2/4: k3s single-node install =="
if ! command -v k3s >/dev/null 2>&1; then
  # Keep the bundled klipper servicelb ENABLED: it is what binds host ports
  # 80/443 and forwards them to the traefik LoadBalancer Service. Disabling it
  # (as an earlier version did) leaves traefik's Service EXTERNAL-IP <pending>
  # and nothing listening on the host — traefik does NOT self-bind hostPorts.
  # traefik is the only LB Service here, so there is no port contention.
  # --write-kubeconfig-mode 644: lets non-root user read kubeconfig.
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -s -
  echo "  k3s installed"
else
  echo "  k3s already installed, skipping"
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
if ! command -v helm >/dev/null 2>&1; then
  curl -sSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  echo "  helm installed"
else
  echo "  helm already installed, skipping"
fi

echo
echo "== Step 4/4: cert-manager + LetsEncrypt ClusterIssuer =="
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

if ! kubectl get ns cert-manager >/dev/null 2>&1; then
  kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.1/cert-manager.yaml
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
