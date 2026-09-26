#!/usr/bin/env bash
# Fails CI if server/functions/service/shared/lib code uses console.* instead of
# the structured logger (lib/logger.ts / functions/lib/logger.js / shared logger).
# CLAUDE.md §2: every server log line carries traceId/userId/noteId/workspaceId.
#
# No allowlist: packages/db/src/db.ts, the last exception, moved to the
# structured logger in the one-Postgres-config change (#15).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/functions"
  "$ROOT/services/api"
  "$ROOT/services"
  "$ROOT/packages/ai"
  "$ROOT/packages/db"
)

found=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  hits="$(grep -RInE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=DerivedData --include='*.ts' --include='*.js' --include='*.cjs' --include='*.mjs' \
            'console\.(log|warn|error|info|debug)\(' "$t" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "$hits"
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo
  echo "ERROR: console.* usage found. Use the structured logger (lib/logger.ts)."
  exit 1
fi
echo "OK: no stray console.* in server dirs."
