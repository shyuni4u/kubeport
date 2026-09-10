#!/usr/bin/env bash
# One-shot infra for local e2e: dex cert, compose (postgres + dex), DB schema,
# frontend/.env.local, kind cluster with OIDC trust, demo RBAC.
# Idempotent — safe to re-run every session. docs/local-e2e.md §2–§6 in code.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
for t in docker kind kubectl atlas openssl node; do need "$t"; done

# 1. Self-signed dex cert (one per machine; kind trusts it at cluster creation).
if [[ ! -f "$DEX_CRT" ]]; then
  log "generating self-signed dex cert"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERT_DIR/dex.key" -out "$DEX_CRT" \
    -subj "/CN=host.docker.internal" \
    -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
fi

# 2. postgres + dex
log "docker compose up"
docker compose -f "$ROOT/deploy/docker/docker-compose.yml" up -d
for i in $(seq 1 30); do
  curl -ksf "$DEX_ISSUER/.well-known/openid-configuration" >/dev/null && break
  [[ $i == 30 ]] && die "dex not reachable at $DEX_ISSUER — check the hosts entry (docs/local-e2e.md §1)"
  sleep 2
done

# 3. schema
log "atlas schema apply"
(cd "$ROOT/backend/migrations" && atlas schema apply --env local --auto-approve >/dev/null)

# 4. frontend/.env.local (key shared with backend.sh via this file)
if [[ ! -f "$ENV_LOCAL" ]]; then
  log "writing frontend/.env.local"
  KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
  cat > "$ENV_LOCAL" <<EOF
DATABASE_URL=postgres://kubeport:kubeport@localhost:5432/kubeport
APP_ENCRYPTION_KEY_B64=$KEY
GO_API_BASE_URL=$API_URL

OIDC_ISSUER=$DEX_ISSUER
OIDC_CLIENT_ID=kubeport
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=$WEB_URL/api/auth/callback

# Demo provider (locally the same dex + client as primary)
DEMO_OIDC_ISSUER=$DEX_ISSUER
DEMO_OIDC_CLIENT_ID=kubeport
DEMO_OIDC_CLIENT_SECRET=local-dev-secret
DEMO_EMAIL_DOMAIN=demo.kubeport
DEMO_ADMIN_EMAIL=demo-admin@demo.kubeport
DEMO_USER_EMAIL=demo-user@demo.kubeport
DEMO_PASSWORD_HINT=demo
# Where the deploy form starts demo sessions (#179) — the namespace seed.sh
# gives the demo accounts RBAC in.
DEMO_NAMESPACE=default
EOF
fi
# The file above is written once, so a checkout from before #179 never got
# DEMO_NAMESPACE — and without it demo sessions open the deploy form on an
# empty namespace. Add just that key, leaving everything else as it is.
if ! grep -q '^DEMO_NAMESPACE=' "$ENV_LOCAL"; then
  log "adding DEMO_NAMESPACE to frontend/.env.local"
  echo 'DEMO_NAMESPACE=default' >> "$ENV_LOCAL"
fi

# 5. kind cluster trusting dex (created once; reused across sessions)
if ! kind get clusters 2>/dev/null | grep -qx kubeport; then
  log "creating kind cluster 'kubeport' with OIDC trust for dex"
  CFG="$(mktemp)"
  cat > "$CFG" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: kubeport
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: $DEX_CRT
        containerPath: /etc/kubernetes/pki/dex-ca.crt
        readOnly: true
    kubeadmConfigPatches:
      - |
        kind: ClusterConfiguration
        apiServer:
          extraArgs:
            oidc-issuer-url: $DEX_ISSUER
            oidc-client-id: kubeport
            oidc-username-claim: email
            oidc-groups-claim: groups
            oidc-ca-file: /etc/kubernetes/pki/dex-ca.crt
    extraPortMappings:
      - containerPort: 6443
        hostPort: 6443
        listenAddress: "127.0.0.1"
EOF
  kind create cluster --config "$CFG" --wait 2m
  rm -f "$CFG"
fi

# 6. RBAC (apply = idempotent)
log "applying RBAC"
kubectl --context kind-kubeport apply -f - >/dev/null <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: kubeport-admin }
subjects: [{ kind: Group, name: kubeport-admin, apiGroup: rbac.authorization.k8s.io }]
roleRef: { kind: ClusterRole, name: cluster-admin, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: kubeport-users, namespace: default }
subjects: [{ kind: Group, name: "system:authenticated", apiGroup: rbac.authorization.k8s.io }]
roleRef: { kind: ClusterRole, name: edit, apiGroup: rbac.authorization.k8s.io }
YAML
for pair in "demo-admin admin demo-admin@demo.kubeport" "demo-user edit demo-user@demo.kubeport"; do
  set -- $pair
  kubectl --context kind-kubeport create rolebinding "$1" --clusterrole="$2" --user="$3" -n default \
    --dry-run=client -o yaml | kubectl --context kind-kubeport apply -f - >/dev/null
done

log "infra ready. next: scripts/e2e/backend.sh  (terminal 1) · scripts/e2e/frontend.sh (terminal 2) · scripts/e2e/seed.sh · scripts/e2e/run.sh"
