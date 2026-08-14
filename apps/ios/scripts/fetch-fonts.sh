#!/usr/bin/env bash
# Downloads the Rajdhani brand fonts into Wassup/Resources/Fonts/ and verifies
# their PostScript names match what Typography (Theme.swift) looks up.
#
# The TTFs are COMMITTED to the repo — this script is the regeneration tool,
# not a build step. Rajdhani on google/fonts is a static family (per-weight
# TTFs whose PostScript name equals the filename), so no instancing is needed.
#
# Fallback if Google ever converts Rajdhani to a variable font:
#   python3 -m fontTools.varLib.instancer Rajdhani-VF.ttf wght=700 \
#     -o Wassup/Resources/Fonts/Rajdhani-Bold.ttf --update-name-table
#   (--update-name-table rewrites nameIDs 1/2/4/6 for the pinned instance;
#    re-run this script's verify step afterwards.)
set -euo pipefail
cd "$(dirname "$0")/.."

FONTS_DIR="Wassup/Resources/Fonts"
BASE="https://raw.githubusercontent.com/google/fonts/main/ofl/rajdhani"
mkdir -p "$FONTS_DIR"

for w in Medium SemiBold Bold; do
  echo "Fetching Rajdhani-$w.ttf"
  curl -fsSL "$BASE/Rajdhani-$w.ttf" -o "$FONTS_DIR/Rajdhani-$w.ttf"
done
curl -fsSL "$BASE/OFL.txt" -o "$FONTS_DIR/OFL.txt"

# Verify PostScript names (nameID 6) — Typography looks fonts up by this name,
# and a mismatch fails SILENTLY into the system-font fallback. Never again.
python3 - <<'EOF'
from fontTools.ttLib import TTFont
for w in ("Medium", "SemiBold", "Bold"):
    path = f"Wassup/Resources/Fonts/Rajdhani-{w}.ttf"
    ps = TTFont(path)["name"].getDebugName(6)
    assert ps == f"Rajdhani-{w}", f"{path}: PostScript name is {ps!r}, expected Rajdhani-{w}"
    print(f"OK {path} -> {ps}")
EOF

echo "Done. If files were added for the first time: update Info.plist UIAppFonts and re-run 'xcodegen generate'."
