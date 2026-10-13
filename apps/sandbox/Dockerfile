FROM node:20-alpine

# Install dependencies for file processing
RUN apk add --no-cache \
    qpdf \
    poppler-utils \
    libreoffice \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-data \
    python3 \
    py3-pip

# Install OCRmyPDF
RUN pip3 install --no-cache-dir ocrmypdf

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY . .
RUN pnpm build

# Non-root user
RUN addgroup -g 1000 sandbox && \
    adduser -D -u 1000 -G sandbox sandbox
USER sandbox

# Input and output directories
RUN mkdir -p /input /output

ENTRYPOINT ["node", "dist/index.js"]
