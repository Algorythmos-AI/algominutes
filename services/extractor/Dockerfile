# services/extractor — server-side document text extraction (PDF/DOCX/OCR/YouTube).
#
# Modelled on services/transcoder/Dockerfile. Like the transcoder, this service
# depends on a repo-level workspace package (@algominutes/ai) that Cloud Run's
# `--source` build cannot reach by walking up the tree. The deploy step
# (services deploy script, owned by A11) must vendor packages/ai into
# ./vendor/ai before `docker build` — mirroring how the transcoder copies
# repo-level shared/ into ./shared. See the COPY vendor/ai line below.
FROM node:24-bookworm-slim AS runtime

# System packages:
#   poppler-utils  -> pdftoppm, used by extractors/pdf.js to rasterize
#                     image-only PDF pages before OCR (the Node replacement for
#                     the browser's canvas render path).
#   python3/pip    -> yt-dlp is shipped as a Python wheel (we run no Python
#                     ourselves), used by extractors/youtube.js for captions.
#   ca-certificates/curl -> TLS + base tooling.
#
# NOTE: tesseract.js (image OCR) needs NO system tesseract — it ships its own
# WASM engine. It does, however, fetch eng.traineddata + the WASM core at
# runtime into TESSERACT_CACHE_PATH (/tmp). TODO(extractor): bake eng.traineddata
# and the tesseract core into the image and point langPath/corePath at them, so
# a cold start does not pay a model download on the first OCR request.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        poppler-utils \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Bump yt-dlp to latest; YouTube protocol drift is real. The `default` extra
# installs yt-dlp-ejs, which solves YouTube's signature/n challenges (the base
# node image provides the `node` JS runtime yt-dlp-ejs needs).
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

COPY package.json ./
# Vendored by the deploy step (see header). Placed into node_modules before
# install so `npm install` sees the "@algominutes/ai": "*" requirement already
# satisfied (a `*` range matches any present version) and does not try to fetch
# it from a registry. Only logger.cjs is used at runtime, and it has no
# dependencies of its own.
COPY vendor/ai ./node_modules/@algominutes/ai
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV TESSERACT_CACHE_PATH=/tmp/tesseract
EXPOSE 8080

CMD ["node", "src/index.js"]
