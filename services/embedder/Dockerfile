# services/embedder — chunks transcript_lines, embeds via
# text-embedding-004 (768-dim), writes pgvector rows.
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
