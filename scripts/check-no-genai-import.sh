#!/usr/bin/env bash
# Fails CI if a Cloud Run service imports the PUBLIC Gemini client
# (@google/generative-ai). Those services run behind the VPC connector +
# private IP, where only Vertex (aiplatform.googleapis.com) is reachable;
# generativelanguage.googleapis.com is not. Bug 13's lesson — use
# @google-cloud/aiplatform / the Vertex SDK instead. Targets SOURCE imports,
# not package.json deps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=(
  "$ROOT/functions"
  "$ROOT/services"
  "$ROOT/packages/ai"
)
PATTERN="(require\(['\"]@google/generative-ai|from ['\"]@google/generative-ai)"

found=0
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || continue
  if grep -RInE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=DerivedData --include='*.ts' --include='*.js' --include='*.cjs' --include='*.mjs' "$PATTERN" "$t" 2>/dev/null; then
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo
  echo "ERROR: Cloud Run service imports @google/generative-ai (public Gemini client)."
  echo "Use the Vertex SDK (@google-cloud/aiplatform) — see CLAUDE.md, Bug 13."
  exit 1
fi
echo "OK: no public @google/generative-ai imports in services/shared."
