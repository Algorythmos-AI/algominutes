# services/transcoder — long-audio routing + STT v2 ingestion.
#
# Deploy via services/deploy.sh transcoder, which copies repo-level
# shared/ into ./shared before docker build (Cloud Run --source can't
# walk up the tree).
FROM node:22-bookworm-slim AS runtime

# ffmpeg for transcode/chunk; yt-dlp for YouTube ingest. python3 is
# only here because yt-dlp is shipped as a Python wheel; we don't run
# any Python ourselves.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Bump yt-dlp to latest; YouTube protocol drift is real. The `default`
# extra installs yt-dlp-ejs, which solves YouTube's signature/n challenges.
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Monorepo port: shared/ became @algominutes/ai + @algominutes/db workspaces.
# Build context is the repo root. TODO(build): wire full npm workspaces install (A11).
COPY packages/ai ./node_modules/@algominutes/ai
COPY packages/db ./node_modules/@algominutes/db
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
