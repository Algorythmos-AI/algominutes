# services/db-job — Cloud Run Job for programmatic DB ops
# (verification queries, corpus backfill, etc).
#
# Runs inside the wassup-meeting VPC with native private-IP access to
# wassup-meeting-pg. Per CLAUDE.md §2 invariants:
#   - imports shared/redaction.cjs for any text reaching Gemini/embedder
#   - uses Postgres as source of truth
#   - no console.* — uses pino-style structured logger from shared/
#   - traceId/userId/noteId/workspaceId in every log line
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# `services/deploy.sh` (or services/deploy-image-only.sh per Phase δ.2)
# copies repo's shared/ into ./shared before `gcloud builds submit`.
# Monorepo port: shared/ became @algominutes/ai + @algominutes/db workspaces.
# Build context is the repo root. TODO(build): wire full npm workspaces install (A11).
COPY packages/ai ./node_modules/@algominutes/ai
COPY packages/db ./node_modules/@algominutes/db
# evals/ — used by eval-recall handler (PR-G recall@k)
COPY evals ./evals
COPY src ./src

ENV NODE_ENV=production

# Cloud Run Jobs don't take HTTP traffic — no PORT, no EXPOSE.
# Job runs `index.js` once per execution, exits 0 on success, non-zero on failure.
CMD ["node", "src/index.js"]
