# services/transcoder — long-audio routing + STT ingestion (Cloud Run, Node 24).
#
# BUILD CONTEXT = REPO ROOT (npm links the @algominutes/* workspaces). Runs
# under tsx because it imports @algominutes/db TypeScript source.
#   docker build -f services/transcoder/Dockerfile -t algominutes-transcoder .
FROM node:25-bookworm-slim AS runtime

# ffmpeg for transcode/chunk; yt-dlp for YouTube ingest. python3 is only here
# because yt-dlp ships as a Python wheel; we run no Python ourselves. The
# `default` extra installs yt-dlp-ejs, which solves YouTube's signature/n
# challenges (the base node image provides the JS runtime it needs).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/transcoder/package.json ./services/transcoder/

RUN npm install \
      -w @algominutes/transcoder \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/transcoder ./services/transcoder

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/transcoder
CMD ["npx", "tsx", "src/index.js"]
