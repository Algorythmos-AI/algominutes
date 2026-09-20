# services/billing — revenue rails (Cloud Run, Node 24).
#
# Server-side receipt validation (StoreKit 2 / Play), Stripe Checkout + Billing
# Portal, and the PUBLIC store/Stripe webhooks. Own service so public webhook
# traffic never shares a scaling pool with authed user traffic in services/api.
#
# BUILD CONTEXT = REPO ROOT. Runs under tsx (imports @algominutes/db TS source).
#   docker build -f services/billing/Dockerfile -t algominutes-billing .
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY services/billing/package.json ./services/billing/

RUN npm install \
      -w @algominutes/billing \
      -w @algominutes/db \
      -w @algominutes/ai \
      -w @algominutes/contracts \
      --omit=dev --no-audit --no-fund

COPY packages/ai ./packages/ai
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY services/billing ./services/billing

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/services/billing
CMD ["npx", "tsx", "src/index.js"]
