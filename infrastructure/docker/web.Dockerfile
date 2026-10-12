# syntax=docker/dockerfile:1

# ---- Build the static web client ----
FROM node:24.18.0-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile --filter=@ogc/web...
RUN pnpm turbo run build --filter=@ogc/web...
# Source maps are for error tooling, not for public download.
RUN find apps/web/dist -name '*.map' -delete

# ---- Serve with unprivileged nginx ----
FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
COPY infrastructure/docker/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
