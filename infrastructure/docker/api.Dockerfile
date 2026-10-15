# syntax=docker/dockerfile:1

# ---- Build: install the workspace, build the API and its workspace dependencies ----
FROM node:26.11.1-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo

# Download every locked package first, into a BuildKit cache that survives rebuilds: this layer
# only reruns when the lockfile changes, and later steps install offline (no network flakiness).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN --mount=type=cache,id=ogc-pnpm-store,target=/pnpm-store \
    pnpm fetch --store-dir=/pnpm-store

COPY . .
RUN --mount=type=cache,id=ogc-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --offline --store-dir=/pnpm-store --filter=@ogc/api...
RUN pnpm turbo run build --filter=@ogc/api...
# Self-contained production bundle: only runtime dependencies, no dev tooling. (`deploy --legacy`
# re-resolves package metadata, so it needs the registry; package files come from the cache.)
RUN --mount=type=cache,id=ogc-pnpm-store,target=/pnpm-store \
    pnpm --filter=@ogc/api deploy --prod --legacy --store-dir=/pnpm-store /out \
 && cp -r apps/api/dist /out/dist

# ---- Migrate: one-shot job that applies database migrations, then exits ----
# Kept separate so the runtime image contains no Prisma CLI or migration tooling.
FROM build AS migrate
WORKDIR /repo/apps/api
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ---- Runtime: minimal, non-root ----
FROM node:26.11.1-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist

USER node
EXPOSE 3000
# Liveness. Deployments additionally gate traffic on /api/v1/health/ready (docker-compose.prod.yml).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/v1/health || exit 1
# SIGTERM (the default) starts Nest's graceful shutdown: readiness turns 503, then connections close.
STOPSIGNAL SIGTERM

CMD ["node", "--enable-source-maps", "dist/main.js"]
