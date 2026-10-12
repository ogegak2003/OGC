# syntax=docker/dockerfile:1

# ---- Build: install the workspace, build the API and its workspace dependencies ----
FROM node:24.18.0-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile --filter=@ogc/api...
RUN pnpm turbo run build --filter=@ogc/api...
# Self-contained production bundle: only runtime dependencies, no dev tooling.
RUN pnpm --filter=@ogc/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

# ---- Runtime: minimal, non-root ----
FROM node:24.18.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "--enable-source-maps", "dist/main.js"]
