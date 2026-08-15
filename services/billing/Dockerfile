# services/billing — AlgoMinutes revenue rails (Cloud Run, Node 24).
#
# BUILD-PLAN §3.2 / A9.4-A9.5. This service owns the PUBLIC store + Stripe
# webhooks and the authed purchase-verify/checkout/portal endpoints. It runs in
# its OWN Cloud Run service (own scaling pool) so a webhook retry-storm from
# Apple/Google/Stripe never starves user request capacity in services/api.
#
# BUILD CONTEXT = REPO ROOT. Like services/api, this service imports the
# workspace packages @algominutes/db (TypeScript source: subscriptions-repo.ts,
# analytics-repo.ts) and @algominutes/ai, so the image is built from the
# monorepo root — the shared packages are COPY-vendored in (the transcoder
# pattern) and the whole workspace graph (db → contracts → pg/zod, ai) is
# installed with `npm install -w`. Deploy with, e.g.:
#
#   gcloud run deploy algominutes-billing \
#     --source . \
#     --dockerfile services/billing/Dockerfile
#
# Node cannot type-strip .ts under node_modules and there is no build step, so
# the service runs under tsx — the same on-the-fly TS runtime services/api uses.

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# ── deps layer ─────────────────────────────────────────────────────────
# Copy the root manifest and only the workspace manifests this service needs,
# so `npm install` is cached until a manifest actually changes.
COPY package.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/db/package.json ./packages/db/
COPY packages/contracts/package.json ./packages/contracts/
COPY services/billing/package.json ./services/billing/

# Install this service's workspace graph. @algominutes/db pulls in
# @algominutes/contracts + pg transitively; tsx is a runtime dep of
# @algominutes/billing, so --omit=dev keeps it.
RUN npm install \
      -w @algominutes/billing \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

# ── source ─────────────────────────────────────────────────────────────
COPY packages/ai ./packages/ai
COPY packages/db ./packages/db
COPY packages/contracts ./packages/contracts
COPY services/billing ./services/billing

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/billing
CMD ["npx", "tsx", "src/index.js"]
