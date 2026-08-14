# services/api — AlgoMinutes HTTP edge (Cloud Run, Node 24).
#
# Consolidates the source's Express server.ts and the five Firebase Functions
# handlers into ONE service (BUILD-PLAN §3.1).
#
# BUILD CONTEXT = REPO ROOT. This service imports the workspace packages
# @algominutes/db (which ships TypeScript source: notes-repo.ts, search-repo)
# and @algominutes/ai, so the image must be built from the monorepo root, not
# from services/api. Deploy with, e.g.:
#
#   gcloud run deploy algominutes-api \
#     --source . \
#     --dockerfile services/api/Dockerfile
#
# Node cannot type-strip .ts files under node_modules, and there is no build
# step (deps install post-A4), so the service runs under tsx — the same
# on-the-fly TypeScript runtime the source used for `tsx server.ts`.

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# ── deps layer ─────────────────────────────────────────────────────────
# Copy the root manifest and only the workspace manifests this service needs,
# so `npm install` is cached until a manifest actually changes.
COPY package.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/db/package.json ./packages/db/
COPY services/api/package.json ./services/api/

# Install just this service's workspace graph (api + the two libs it imports).
# tsx is a runtime dependency of @algominutes/api, so --omit=dev keeps it.
RUN npm install \
      -w @algominutes/api \
      -w @algominutes/db \
      -w @algominutes/ai \
      --omit=dev --no-audit --no-fund

# ── source ─────────────────────────────────────────────────────────────
COPY packages/ai ./packages/ai
COPY packages/db ./packages/db
COPY services/api ./services/api

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/api
CMD ["npx", "tsx", "src/index.js"]
