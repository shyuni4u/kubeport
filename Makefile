.PHONY: compose-up compose-down test e2e e2e-ui helm-sync helm-lint helm-snapshot helm-snapshot-update

HELM_CHART_DIR := deploy/helm/kubeport

# Through scripts/compose.sh: the shared stack always runs from the main
# checkout, so `make compose-up` in a worktree cannot hand it that worktree (#230).
compose-up:
	scripts/compose.sh up -d

compose-down:
	scripts/compose.sh down

test:
	cd backend && go test ./...

# Full end-to-end happy-path smoke covering the Plan 1 vertical slice.
# Requires: docker compose up, a kind cluster with its API URL in KBP_KIND_API,
# kubectl configured for the same cluster.
e2e: compose-up
	cd backend/migrations && atlas schema apply --env local --auto-approve
	cd backend && go test -tags=e2e ./e2e/... -v

# Browser-level Plan 2 regression suite. Requires the full local-e2e.md
# stack (compose + kind + backend + frontend dev) to be running first.
e2e-ui:
	cd frontend && pnpm test:e2e

# ----- Helm chart -------------------------------------------------------
# schema.hcl is shipped twice on disk: the source of truth lives at
# backend/migrations/schema.hcl, and the chart-embedded copy at
# deploy/helm/kubeport/files/schema.hcl. Run helm-sync after editing the
# source to keep them aligned. CI verifies they match.
helm-sync:
	cp backend/migrations/schema.hcl $(HELM_CHART_DIR)/files/schema.hcl

# Besides linting, prove the demo email guard in templates/demo-namespace.yaml
# still refuses what it must (#208, #209) and still accepts a differently cased
# demo.emailDomain, which the backend compares case-insensitively.
helm-lint:
	helm lint $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml
	@helm template kp $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--set demo.adminEmail=ops@example.org 2>&1 | grep -q "must end in @demo.kubeport" \
		|| { echo "demo email guard: an admin email outside demo.emailDomain rendered"; exit 1; }
	@helm template kp $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--set demo.userEmail=someone-else@demo.kubeport 2>&1 | grep -q "must match one of dex.staticPasswords" \
		|| { echo "demo email guard: a user email Dex does not know rendered"; exit 1; }
	@helm template kp $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--set-string "demo.adminEmail=ops@example.org\,demo-admin@demo.kubeport" 2>&1 | grep -q "must be a single address" \
		|| { echo "demo email guard: a comma-joined admin email rendered"; exit 1; }
	@helm template kp $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--set demo.emailDomain=DEMO.kubeport >/dev/null \
		|| { echo "demo email guard: refused a demo.emailDomain that differs only in case"; exit 1; }
	@helm template kp $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--set demo.enabled=false 2>&1 | grep -q "dex.enabled=true requires demo.enabled=true" \
		|| { echo "demo email guard: dex rendered without demo mode (#253)"; exit 1; }
	@echo "demo email guard: ok"

# Diff the rendered chart against the checked-in golden snapshot. Fails
# (non-zero exit) if they differ — that is the CI signal.
helm-snapshot: helm-sync
	@helm template kp $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--namespace kubeport \
		| diff -u $(HELM_CHART_DIR)/ci/snapshot.yaml -

# Regenerate the golden snapshot. Run this when an intentional template
# change is made; commit the diff alongside the template change.
#
# Check `helm version` first. CI pins helm 3.20.2 (.github/workflows/helm.yml),
# and helm 4 emits an extra blank line before every document separator — so
# regenerating with helm 4 rewrites ~18 unrelated lines and CI then fails on a
# snapshot it cannot reproduce. Either use helm 3, or strip those blank lines
# and confirm the diff against the committed snapshot shows additions only.
helm-snapshot-update: helm-sync
	helm template kp $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--namespace kubeport \
		> $(HELM_CHART_DIR)/ci/snapshot.yaml
