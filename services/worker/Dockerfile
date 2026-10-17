# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/worker/Dockerfile -t pd-worker .

FROM node:20-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pd/worker..."
RUN pnpm --filter @pd/worker build
RUN pnpm --filter @pd/worker deploy --prod /out

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
# The workspace packages ship TypeScript source, so Node loads them through tsx.
CMD ["node", "--import", "tsx", "dist/index.js"]
