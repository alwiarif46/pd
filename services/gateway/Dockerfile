# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f services/gateway/Dockerfile -t pd-api .

FROM node:20-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY . .
# Only this app and the workspace packages it depends on.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pd/api..."
RUN pnpm --filter @pd/api build
# Standalone copy with production dependencies only; workspace packages are copied in.
RUN pnpm --filter @pd/api deploy --prod /out

# One-off migration image (compose service `migrate`): the full workspace with dev
# dependencies, because drizzle-kit is one. Runs as the owner role; never started with the app.
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["pnpm", "db:migrate"]

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 3001
# The workspace packages ship TypeScript source (their package.json main is src/index.ts),
# so Node loads them through tsx.
CMD ["node", "--import", "tsx", "dist/index.js"]
