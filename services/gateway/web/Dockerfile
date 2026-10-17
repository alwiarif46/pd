# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/gateway/web/Dockerfile -t pd-web .
# Static files only. Production TLS and routing are the host nginx (infra/nginx.conf); this
# image serves the build on port 8080 as a non-root user.

FROM node:20-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pd/web..."
RUN pnpm --filter @pd/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/gateway/web/dist /usr/share/nginx/html
EXPOSE 8080
