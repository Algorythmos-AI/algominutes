# services/notifier — A7.3 FCM push fan-out.
#
# Deploy via services/deploy.sh notifier, which copies the repo-level
# workspace packages into ./node_modules/@algominutes before docker build
# (Cloud Run --source can't walk up the tree). Build context is the repo root.
#
# Node 24: the @algominutes/db repo layer ships TypeScript source, resolved at
# runtime by Node's type-stripping + .js→.ts resolution (>=24). TODO(build):
# wire full npm workspaces install (A11).
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Monorepo port: shared/ became @algominutes/ai + @algominutes/db workspaces.
COPY packages/ai ./node_modules/@algominutes/ai
COPY packages/db ./node_modules/@algominutes/db
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
