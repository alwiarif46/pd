FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    qpdf \
    poppler-utils \
    libreoffice-writer \
    tesseract-ocr \
    tesseract-ocr-eng \
    ghostscript \
    ocrmypdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install -g pnpm && pnpm install

COPY . .
RUN pnpm build

RUN mkdir -p /input /output \
    && usermod -l sandbox node \
    && groupmod -n sandbox node \
    && chown -R sandbox:sandbox /input /output /app

USER sandbox

ENTRYPOINT ["node", "dist/index.js"]
