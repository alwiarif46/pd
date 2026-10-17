# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/modelgw/Dockerfile -t e2e-modelgw .

FROM node:20-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY . .
# Only this service and the workspace packages it depends on.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pd/modelgw..."
RUN pnpm --filter @pd/modelgw build
# Standalone copy with production dependencies only; workspace packages are copied in.
RUN pnpm --filter @pd/modelgw deploy --prod /out

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
ENV PORT=4106
EXPOSE 4106
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4106/healthz || exit 1
# The workspace packages ship TypeScript source (their package.json main is src/index.ts),
# so Node loads them through tsx.
CMD ["node", "--import", "tsx", "dist/index.js"]
