#!/usr/bin/env bash
# Fails CI on direct Firestore note mutations outside the repo/mirror layer.
# CLAUDE.md §2: Postgres is source of truth; Firestore is a denormalized cache.
# All note mutations go through lib/notes-repo.ts (server) or the established
# Cloud Functions / Cloud Run mirror modules. New code must not write note docs
# directly.
#
# This is a coarse grep backstop — the dual-write-auditor sub-agent does the
# authoritative check. It matches the common one-liner idioms and allowlists the
# known repo/mirror sites.
#
# ALLOWLIST (legitimate repo + mirror writers), same as check-no-direct-firestore.mjs:
#   - packages/db/src/notes-repo.ts             (the repo layer)
#   - packages/ai/src/note-terminal.cjs         (terminal-failure writer: PG first, then mirror)
#   - services/transcoder/src/firestore-mirror.js
#   - services/summarizer/src/handler.js        (Cloud Run mirror; tracked TODO)
#
# (services/api/src/routes/process-intelligence.js was allowlisted here as a
#  "ported mirror" and hid six direct note-status writes plus an unguarded
#  cross-tenant Postgres upsert. It now goes through notes-repo; never
#  allowlist a whole route file again.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/functions"
  "$ROOT/services/api"
  "$ROOT/services"
  "$ROOT/packages/db"
)
# One-line writes are covered syntax-aware by check-no-direct-firestore.mjs
# (run at the end, which also catches multi-line writes). Kept here: any direct
# reference to the notes collection outside the allowlisted layer.
PATTERNS=(
  "collection\((['\"])notes\1\)"
)
ALLOWLIST_RE='(packages/db/src/notes-repo\.ts|packages/ai/src/note-terminal\.cjs|services/transcoder/src/firestore-mirror\.js|services/summarizer/src/handler\.js)'

found=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  for p in "${PATTERNS[@]}"; do
    hits="$(grep -RInE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=DerivedData --include='*.ts' --include='*.js' --include='*.cjs' --include='*.mjs' \
              "$p" "$t" 2>/dev/null | grep -vE "$ALLOWLIST_RE" || true)"
    if [ -n "$hits" ]; then
      echo "$hits"
      found=1
    fi
  done
done

if [ "$found" -ne 0 ]; then
  echo
  echo "ERROR: direct reference to the notes collection outside the repo/mirror layer."
  echo "Route note writes through @algominutes/db (notes-repo) — CLAUDE.md §1."
  exit 1
fi

# Document writes (any formatting, multi-line included): syntax-aware.
cd "$ROOT" && node scripts/check-no-direct-firestore.mjs
