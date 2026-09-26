#!/bin/sh
# Writes TestFlight's "What to Test" for this build (plan S1-PR9), for
# ci_post_xcodebuild.sh. Xcode Cloud attaches apps/ios/TestFlight/
# WhatToTest.en-US.txt to the build it uploads.
#
#   1. A header: the version, the build number, and the commit. Xcode Cloud
#      can't push tags, so this line is the record of which commit a build is.
#   2. What to try: apps/ios/release-notes/what-to-test.txt, written by hand
#      for each build that needs it.
#   3. What changed: the 10 newest feat and fix commits that touched the
#      app's own code (not its tests or CI), as their subjects read.
#
# TestFlight allows 4,000 characters; the list is cut to fit. Notes are never
# worth failing a build over: anything missing is left out, and said so.
#
# Usage: what-to-test.sh <output file>. Reads CI_BUILD_NUMBER when set.
set -eu

OUT=${1:?usage: what-to-test.sh <output file>}
LIMIT=4000
MAX_ITEMS=10
REPO=$(git rev-parse --show-toplevel)
IOS="$REPO/apps/ios"

VERSION=$(sed -nE 's/^    MARKETING_VERSION: "([^"]+)"$/\1/p' "$IOS/project.yml" | head -n 1)
BUILD=${CI_BUILD_NUMBER:-local}
SHA=$(git rev-parse --short=12 HEAD)

# Xcode Cloud clones shallow: fetch enough history for the list.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --quiet --deepen 100 || echo "warning: couldn't deepen the clone; What to Test lists the commits it has"
fi

TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.list"' EXIT

# Comment lines (#) are notes for whoever edits the file; blank lines at
# either end are dropped.
FOCUS="$IOS/release-notes/what-to-test.txt"
TRY=""
if [ -f "$FOCUS" ]; then
  TRY=$(grep -v '^#' "$FOCUS" | awk 'NF { if (s) for (; n > 0; n--) print ""; n = 0; s = 1; print; next } { n++ }')
fi

{
  echo "AlgoMinutes ${VERSION:-?} (${BUILD}), commit ${SHA}"
  if [ -n "$TRY" ]; then
    echo
    echo "WHAT TO TRY"
    printf '%s\n' "$TRY"
  fi
  echo
  echo "RECENT CHANGES (newest first)"
} > "$TMP"

TAIL="
Found a problem? Take a screenshot in the app and tap Share Beta Feedback, or
send feedback from the TestFlight app. To ask for more minutes, include your
User ID from Settings."

# feat/fix/perf commits that touched the app or its extension, subject only:
# "feat(ios): a thing (#12)" becomes "- A thing".
git log --first-parent --no-merges -n 30 --format=%s HEAD -- \
    "$IOS/AlgoMinutes" "$IOS/BroadcastExtension" \
  | grep -E '^(feat|fix|perf)(\([^)]*\))?!?: ' \
  | sed -E -e 's/^[a-z]+(\([^)]*\))?!?: //' -e 's/ \(#[0-9]+\)$//' \
  | awk -v max="$MAX_ITEMS" 'NR <= max { print "- " toupper(substr($0, 1, 1)) substr($0, 2) }' > "$TMP.list" || true

if [ ! -s "$TMP.list" ]; then
  echo "- (no app changes found in the history this build could see)" > "$TMP.list"
fi

# Keep whole lines while the total stays within TestFlight's limit.
USED=$(( $(wc -c < "$TMP") + ${#TAIL} + 1 ))
while IFS= read -r line; do
  LEN=$(( $(printf '%s\n' "$line" | wc -c) ))
  if [ $(( USED + LEN )) -gt "$LIMIT" ]; then
    break
  fi
  printf '%s\n' "$line" >> "$TMP"
  USED=$(( USED + LEN ))
done < "$TMP.list"

printf '%s\n' "$TAIL" >> "$TMP"
mkdir -p "$(dirname "$OUT")"
mv "$TMP" "$OUT"
echo "What to Test: $(wc -c < "$OUT" | tr -d ' ') characters, written to $OUT"
