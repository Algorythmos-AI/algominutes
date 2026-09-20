# services/summarizer — generates the note summary (gist, action items, decisions) via Vertex Gemini (Cloud Run, Node 24).
#
# BUILD CONTEXT = REPO ROOT (npm links the @algominutes/* workspaces). Runs
# under tsx because it imports @algominutes/db TypeScript source and there is
# no build step.
#   docker build -f services/summarizer/Dockerfile -t algominutes-summarizer .
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/summarizer/package.json ./services/summarizer/

RUN npm install \
      -w @algominutes/summarizer \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/summarizer ./services/summarizer

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/summarizer
CMD ["npx", "tsx", "src/index.js"]
