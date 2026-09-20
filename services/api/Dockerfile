# services/api — AlgoMinutes HTTP edge (Cloud Run, Node 24).
#
# Consolidates the source's Express server.ts and the five Firebase Functions
# handlers into ONE service (BUILD-PLAN §3.1).
#
# BUILD CONTEXT = REPO ROOT (all service images build from the monorepo root so
# npm can link the @algominutes/* workspaces). The service imports the workspace
# packages @algominutes/{db,ai,contracts}; @algominutes/db ships TypeScript
# source (notes-repo.ts …) and there is no build step, so the service runs under
# tsx — the on-the-fly TypeScript runtime.
#
#   docker build -f services/api/Dockerfile -t algominutes-api .
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# ── deps layer ─────────────────────────────────────────────────────────
# Copy the root manifest + lockfile and only the workspace manifests this
# service needs (its own + the transitive @algominutes closure db → ai,
# contracts), so `npm install` is cached until a manifest changes.
COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/api/package.json ./services/api/

RUN npm install \
      -w @algominutes/api \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

# ── source ─────────────────────────────────────────────────────────────
COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/api ./services/api

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/api
CMD ["npx", "tsx", "src/index.js"]
