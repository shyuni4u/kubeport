# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the kubeport Next.js BFF.
#
# Multi-arch (linux/amd64 + linux/arm64) via buildx — see ADR 0003 §"공통 스택".
# Unlike the Go binary, Node native modules (e.g. node-pg) need per-arch builds,
# so QEMU emulation runs the build steps for the non-native target. Slower but
# correct.
#
# Uses Next.js standalone output (next.config.ts: output: 'standalone') —
# produces a self-contained .next/standalone/ with server.js + minimal node_modules.

# === Stage 1: deps ===
# Install pnpm via corepack, then install all dependencies (cached separately
# from source so pure source edits don't reinstall).
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# === Stage 2: builder ===
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 일부 Next.js 프로젝트는 정적 자산이 아예 없어서 public/ 가 git 에 없음.
# runner 스테이지의 `COPY /app/public` 이 항상 성공하도록 보장.
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN pnpm build

# === Stage 3: runner ===
# Tiny final image — only standalone output + static + public assets.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root for security. uid/gid 1001 to avoid colliding with node's bundled user (1000).
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# Standalone bundle: server.js + minimal node_modules + middleware + ...
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static files Next.js serves directly (not bundled into server.js).
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# /public is served by Next.js but not part of standalone output.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# server.js is at the root after standalone copy.
CMD ["node", "server.js"]
