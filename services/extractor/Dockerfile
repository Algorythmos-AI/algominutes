# services/extractor — server-side document text extraction (PDF/DOCX/OCR/YouTube).
#
# BUILD CONTEXT = REPO ROOT (npm links the @algominutes/* workspaces). This
# service imports ONLY @algominutes/ai (CommonJS, no TypeScript), so it runs on
# plain `node` — it does not need tsx or @algominutes/db.
#   docker build -f services/extractor/Dockerfile -t algominutes-extractor .
FROM node:25-bookworm-slim AS runtime

# System packages:
#   poppler-utils        -> pdftoppm, rasterizes image-only PDF pages before OCR.
#   python3/pip          -> yt-dlp ships as a Python wheel (we run no Python
#                           ourselves); `[default]` adds yt-dlp-ejs for YouTube's
#                           signature/n challenges.
#   ca-certificates/curl -> TLS + base tooling.
# tesseract.js (image OCR) needs NO system tesseract — it ships its own WASM
# engine, fetched at runtime into TESSERACT_CACHE_PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY services/extractor/package.json ./services/extractor/

RUN npm install \
      -w @algominutes/extractor \
      -w @algominutes/ai \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY services/extractor ./services/extractor

ENV NODE_ENV=production
ENV PORT=8080
ENV TESSERACT_CACHE_PATH=/tmp/tesseract
EXPOSE 8080

WORKDIR /app/services/extractor
CMD ["node", "src/index.js"]
