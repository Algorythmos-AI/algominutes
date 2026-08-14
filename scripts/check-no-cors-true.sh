#!/usr/bin/env bash
# Fails CI if a Cloud Function uses `cors: true`. CLAUDE.md §2: CORS must use the
# explicit ALLOWED_ORIGINS allowlist, never the wildcard. Comment lines and
# backtick-wrapped doc references (e.g. "use `cors: true`") are ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/services/api"
)

found=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  # Match actual `cors: true` usage; drop comment lines (// or *) and
  # backtick-wrapped mentions in docs/comments.
  if grep -RInE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=DerivedData --include='*.ts' --include='*.js' --include='*.cjs' --include='*.mjs' \
       'cors:[[:space:]]*true' "$t" 2>/dev/null | grep -vE '(^[^:]*:[0-9]+:[[:space:]]*(//|\*))|`|//' ; then
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo
  echo "ERROR: 'cors: true' found. Use the ALLOWED_ORIGINS allowlist (buildCorsMiddleware)."
  exit 1
fi
echo "OK: no 'cors: true' wildcard CORS."
