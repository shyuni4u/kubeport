.PHONY: compose-up compose-down test e2e e2e-ui helm-sync helm-lint helm-snapshot helm-snapshot-update

HELM_CHART_DIR := deploy/helm/kubeport

compose-up:
	docker compose -f deploy/docker/docker-compose.yml up -d

compose-down:
	docker compose -f deploy/docker/docker-compose.yml down

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

helm-lint:
	helm lint $(HELM_CHART_DIR) -f $(HELM_CHART_DIR)/ci/test-values.yaml

# Diff the rendered chart against the checked-in golden snapshot. Fails
# (non-zero exit) if they differ — that is the CI signal.
helm-snapshot: helm-sync
	@helm template kp $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--namespace kubeport \
		| diff -u $(HELM_CHART_DIR)/ci/snapshot.yaml -

# Regenerate the golden snapshot. Run this when an intentional template
# change is made; commit the diff alongside the template change.
helm-snapshot-update: helm-sync
	helm template kp $(HELM_CHART_DIR) \
		-f $(HELM_CHART_DIR)/ci/test-values.yaml \
		--namespace kubeport \
		> $(HELM_CHART_DIR)/ci/snapshot.yaml
