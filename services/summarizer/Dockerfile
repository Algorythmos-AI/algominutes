# services/summarizer — chunked-pipeline post-processor.
# Reads transcript_lines from Postgres, redacts PII, calls Gemini with
# prompt-caching enabled, writes summaries/action_items/key_decisions,
# mirrors status:'ready' to Firestore.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Monorepo port: shared/ became @algominutes/ai + @algominutes/db workspaces.
# Build context is the repo root. TODO(build): wire full npm workspaces install (A11).
COPY packages/ai ./node_modules/@algominutes/ai
COPY packages/db ./node_modules/@algominutes/db
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
