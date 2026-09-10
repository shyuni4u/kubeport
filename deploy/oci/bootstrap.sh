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
#   # k3s 는 고정 버전(K3S_PINNED, Step 2)으로 깔린다 (#194). 복구 등으로 다른 버전이 필요할 때만:
#   sudo BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_K3S_VERSION=v1.xx.y+k3s1 bash bootstrap.sh
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
# BOOTSTRAP_AUTH_API overrides the AuthenticationConfiguration apiVersion —
# default apiserver.config.k8s.io/v1 (GA, k8s >= 1.34); k8s 1.30–1.33 needs
# apiserver.config.k8s.io/v1beta1.
if [[ -n "${BOOTSTRAP_OIDC_CLIENT_ID:-}" ]]; then
  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/auth.yaml <<YAML
apiVersion: ${BOOTSTRAP_AUTH_API:-apiserver.config.k8s.io/v1}
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

# Pinned rather than whatever get.k3s.io calls stable on the day this runs (#194).
# k3s bundles Traefik, so an unpinned install silently changes the ingress in
# front of kubeport as well — including the entrypoint timeout defaults that
# bound how long a log stream can stay open. A VM rebuilt during recovery would
# otherwise come up on a k3s/Traefik pair nobody has run. The structured
# AuthenticationConfiguration above also needs k8s >= 1.34 for its default
# apiserver.config.k8s.io/v1.
#
# This is what production runs (measured 2026-09-10: v1.36.3+k3s1, Traefik
# 3.7.8). Bump it in a commit of its own, together with docs/oci-prod-runbook.md
# §2. BOOTSTRAP_K3S_VERSION overrides it — say, to rebuild at a known older
# version — and an override is announced, never silent.
K3S_PINNED="v1.36.3+k3s1"
K3S_VERSION="${BOOTSTRAP_K3S_VERSION:-${K3S_PINNED}}"
if [[ "${K3S_VERSION}" != "${K3S_PINNED}" ]]; then
  echo "  NOTE: BOOTSTRAP_K3S_VERSION=${K3S_VERSION} overrides the pinned ${K3S_PINNED}"
fi

if ! command -v k3s >/dev/null 2>&1; then
  # Keep the bundled klipper servicelb ENABLED: it is what binds host ports
  # 80/443 and forwards them to the traefik LoadBalancer Service. Disabling it
  # (as an earlier version did) leaves traefik's Service EXTERNAL-IP <pending>
  # and nothing listening on the host — traefik does NOT self-bind hostPorts.
  # traefik is the only LB Service here, so there is no port contention.
  # --write-kubeconfig-mode 644: lets non-root user read kubeconfig.
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${K3S_VERSION}" INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -s -
  echo "  k3s ${K3S_VERSION} installed"
else
  # An existing install is left as it is. Changing the k3s version restarts
  # the control plane, which is a decision for a person (CLAUDE.md "사용자에게
  # 먼저 묻는 것"), not a side effect of re-running bootstrap. Say when it
  # differs from the pin, so a re-run on an old VM does not read as "on the
  # pinned version".
  installed="$(k3s --version 2>/dev/null | awk 'NR==1 {print $3}' || true)"
  if [[ "${installed}" == "${K3S_VERSION}" ]]; then
    echo "  k3s ${installed} already installed (matches the pin), skipping"
  else
    echo "  WARNING: k3s ${installed:-of unknown version} is installed, but this script pins ${K3S_VERSION}; leaving it unchanged" >&2
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
