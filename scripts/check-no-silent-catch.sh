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
  # A handler that returns a bare value swallows the error just as silently.
  '\.catch\(\s*(\(\s*\)|\(\s*_?[a-zA-Z0-9_]*\s*\)|_?[a-zA-Z0-9_]+)\s*=>\s*(undefined|null|void 0|false|true|0|\[\]|\{\s*\})\s*\)'
  'catch\s*\(\s*_[a-zA-Z0-9_]*\s*\)\s*\{\s*\}'
  'catch\s*\{\s*\}'
)
# Server + shared code is checked syntax-aware by check-no-silent-catch.mjs
# (run at the end). These one-line grep rules remain only for apps/web/src,
# until its own cleanup brings it under the AST gate (BLOCKERS).
TARGETS=(
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
  echo "ERROR: Silent catch handlers detected in apps/web/src. Replace with logger.error(...)."
  exit 1
fi
echo "OK: no one-line silent catch handlers in apps/web/src."

# Server + shared code: syntax-aware (needs `typescript` from npm ci).
cd "$ROOT" && node scripts/check-no-silent-catch.mjs
