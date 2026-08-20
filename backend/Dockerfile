# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the kubeport Go API.
#
# Multi-arch (linux/amd64 + linux/arm64) via buildx — see ADR 0003 §"공통 스택"
# (Phase 1 x86 ↔ Phase 2/3 ARM zero-touch 이전).
#
# Builder pinned to BUILDPLATFORM (native) and Go cross-compiles to TARGETARCH.
# This avoids QEMU during compilation — same speed regardless of target arch.

FROM --platform=$BUILDPLATFORM golang:1.26.2-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev

WORKDIR /src

# Cache go module downloads separately so source edits don't refetch deps.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -trimpath \
      -o /out/server \
      ./cmd/server

# Distroless static — minimal attack surface, no shell, runs as nonroot (uid 65532).
# `:nonroot` tag is multi-arch (amd64 + arm64).
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/server /server

# Backend listens on :8080 by default (override via LISTEN_ADDR env).
EXPOSE 8080

# Required env at runtime (failing fast in main.go if missing):
#   DATABASE_URL OIDC_ISSUER OIDC_AUDIENCE APP_ENCRYPTION_KEY_B64
# Optional: LISTEN_ADDR KBP_OPENAPI_CACHE_MAX
USER nonroot:nonroot
ENTRYPOINT ["/server"]
