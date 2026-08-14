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
# ALLOWLIST (legitimate repo + mirror writers):
#   - lib/notes-repo.ts                         (the repo layer)
#   - functions/index.js                        (Functions error/mirror writes)
#   - services/transcoder/src/firestore-mirror.js
#   - services/summarizer/src/handler.js        (Cloud Run mirror; tracked TODO)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/services/api"
  "$ROOT/services"
  "$ROOT/packages/db"
)
PATTERNS=(
  '\.doc\([^)]*\)\.(set|update|delete)\('
  'noteRef\.(set|update|delete)\('
  "collection\((['\"])notes\1\)"
)
ALLOWLIST_RE='(packages/db/src/notes-repo\.ts|services/api/src/index\.js|services/transcoder/src/firestore-mirror\.js|services/summarizer/src/handler\.js)'

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
  echo "ERROR: direct Firestore note mutation outside the repo/mirror layer."
  echo "Route note writes through lib/notes-repo.ts (see CLAUDE.md §2)."
  exit 1
fi
echo "OK: no direct Firestore note mutations outside the allowlisted layer."
