# services/db-job — one-shot DB jobs dispatcher (Cloud Run Job, Node 24).
#
# Not an HTTP server: invoked as a Cloud Run Job with JOB_NAME set, runs once,
# exits. BUILD CONTEXT = REPO ROOT. Runs under tsx (imports @algominutes/db
# TypeScript source via the repo layer).
#   docker build -f services/db-job/Dockerfile -t algominutes-db-job .
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/db-job/package.json ./services/db-job/

RUN npm install \
      -w @algominutes/db-job \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/db-job ./services/db-job

ENV NODE_ENV=production

WORKDIR /app/services/db-job
CMD ["npx", "tsx", "src/index.js"]
