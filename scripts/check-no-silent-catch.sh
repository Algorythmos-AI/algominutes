#!/usr/bin/env bash
# Fails CI if anyone re-introduces silent error swallowers like
#   .catch(() => {})
#   .catch(_ => {})
#   try { ... } catch (_) {}
#   try { ... } catch {}
# in the server, functions, or shared modules. The audit found multiple
# instances of these dropping Firestore write failures on the floor.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATTERNS=(
  '\.catch\(\s*(\(\s*\)|\(\s*_[a-zA-Z0-9_]*\s*\))\s*=>\s*\{\s*\}\s*\)'
  'catch\s*\(\s*_[a-zA-Z0-9_]*\s*\)\s*\{\s*\}'
  'catch\s*\{\s*\}'
)
TARGETS=(
  "$ROOT/functions"
  "$ROOT/services/api"
  "$ROOT/packages/ai"
  "$ROOT/packages/db"
  "$ROOT/services"
  "$ROOT/apps/web/src"
)

found=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  for p in "${PATTERNS[@]}"; do
    if grep -RInE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=DerivedData --include='*.ts' --include='*.tsx' --include='*.js' --include='*.cjs' --include='*.mjs' "$p" "$t" 2>/dev/null; then
      found=1
    fi
  done
done

if [ "$found" -ne 0 ]; then
  echo
  echo "ERROR: Silent catch handlers detected. Replace with logger.error(...)."
  exit 1
fi
echo "OK: no silent catch handlers."
