# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/sandbox/Dockerfile -t pd-sandbox .

FROM node:20-bookworm-slim AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@pd/sandbox..."
RUN pnpm --filter @pd/sandbox build
RUN pnpm --filter @pd/sandbox deploy --prod /out

FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    qpdf \
    poppler-utils \
    libreoffice-writer \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    ocrmypdf \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist

# Run as a non-root user "sandbox" (the image's node user, renamed). /app stays root-owned
# and read-only to it; only /input and /output are writable by it.
RUN mkdir -p /input /output \
    && usermod -l sandbox node \
    && groupmod -n sandbox node \
    && chown -R sandbox:sandbox /input /output

USER sandbox
ENTRYPOINT ["node", "dist/index.js"]
