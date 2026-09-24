# services/notifier — FCM push fan-out on note ready/failed (firebase-admin multicast) (Cloud Run, Node 24).
#
# BUILD CONTEXT = REPO ROOT (npm links the @algominutes/* workspaces). Runs
# under tsx because it imports @algominutes/db TypeScript source and there is
# no build step.
#   docker build -f services/notifier/Dockerfile -t algominutes-notifier .
FROM node:25-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/notifier/package.json ./services/notifier/

RUN npm install \
      -w @algominutes/notifier \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/notifier ./services/notifier

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/notifier
CMD ["npx", "tsx", "src/index.js"]
