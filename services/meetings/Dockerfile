# services/meetings — the Recall.ai notetaker (Cloud Run, Node 24).
#
# The only code that talks to Recall.ai: its signed webhooks (public) and the
# notetaker's Cloud Tasks (OIDC-checked in the app). Own service so webhook
# traffic never shares a scaling pool with the api (docs/plans/MEETINGS.md).
#
# BUILD CONTEXT = REPO ROOT. Runs under tsx (imports @algominutes/db TS source).
#   docker build -f services/meetings/Dockerfile -t algominutes-meetings .
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/meetings/package.json ./services/meetings/

RUN npm install \
      -w @algominutes/meetings \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/meetings ./services/meetings

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/meetings
CMD ["npx", "tsx", "src/index.js"]
