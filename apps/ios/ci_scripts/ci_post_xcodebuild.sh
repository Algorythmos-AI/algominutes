#!/bin/sh
# Xcode Cloud: runs after each xcodebuild action. After an archive:
#
#   1. Write TestFlight's What to Test (what-to-test.sh), which Xcode Cloud
#      reads from TestFlight/ next to ci_scripts/. Notes never fail a build.
#   2. Upload the archive's dSYMs to Crashlytics, so every TestFlight build's
#      crashes are symbolicated. A failed upload fails the build: a build whose
#      crashes can't be read is not one to hand to testers. (The app target's
#      own upload phase skips Xcode Cloud, so nothing uploads twice.)
set -eu

if [ "${CI_XCODEBUILD_ACTION:-}" != "archive" ]; then
  exit 0
fi

cd "${CI_PRIMARY_REPOSITORY_PATH:?not running in Xcode Cloud}/apps/ios"

if ! sh ci_scripts/what-to-test.sh TestFlight/WhatToTest.en-US.txt; then
  echo "warning: What to Test could not be written; this build uploads without notes"
fi

PLIST=AlgoMinutes/Resources/GoogleService-Info.plist
DSYMS="${CI_ARCHIVE_PATH:?no archive path}/dSYMs"
UPLOAD="${CI_DERIVED_DATA_PATH:?no derived data path}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/upload-symbols"

if [ ! -f "$PLIST" ]; then
  echo "error: no GoogleService-Info.plist: set GOOGLE_SERVICE_INFO_PLIST_B64 on this workflow"
  exit 1
fi
if [ ! -x "$UPLOAD" ]; then
  echo "error: Crashlytics upload-symbols not found at $UPLOAD"
  exit 1
fi
if [ ! -d "$DSYMS" ] || [ -z "$(ls -A "$DSYMS")" ]; then
  echo "error: the archive has no dSYMs at $DSYMS (DEBUG_INFORMATION_FORMAT must be dwarf-with-dsym)"
  exit 1
fi

for attempt in 1 2 3; do
  if "$UPLOAD" -gsp "$PLIST" -p ios "$DSYMS"; then
    echo "dSYMs uploaded to Crashlytics (attempt $attempt)"
    exit 0
  fi
  echo "warning: dSYM upload attempt $attempt failed"
  sleep $((attempt * 10))
done
echo "error: dSYMs could not be uploaded to Crashlytics after 3 attempts"
exit 1
