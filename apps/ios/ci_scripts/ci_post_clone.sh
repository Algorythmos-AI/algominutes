#!/bin/sh
# Xcode Cloud (plan PR-30): runs after the clone, before Xcode opens the project.
# See docs/runbooks/xcode-cloud.md for the workflow this expects.
#
#   1. Stamp this build's number (TestFlight needs a new one every upload).
#   2. Write GoogleService-Info.plist from the workflow's secret variable
#      GOOGLE_SERVICE_INFO_PLIST_B64 (base64 of the plist; never committed). A
#      Staging or Release build without it fails in the app's own build script.
#   3. Generate the Xcode project from project.yml (XcodeGen; it isn't committed).
set -eu

cd "${CI_PRIMARY_REPOSITORY_PATH:?not running in Xcode Cloud}/apps/ios"

if [ -n "${CI_BUILD_NUMBER:-}" ]; then
  sed -i '' -E "s/^(    CURRENT_PROJECT_VERSION: )\"[0-9]+\"$/\\1\"${CI_BUILD_NUMBER}\"/" project.yml
  if ! grep -q "^    CURRENT_PROJECT_VERSION: \"${CI_BUILD_NUMBER}\"$" project.yml; then
    echo "error: could not set CURRENT_PROJECT_VERSION to ${CI_BUILD_NUMBER} in project.yml"
    exit 1
  fi
  echo "Build number: ${CI_BUILD_NUMBER}"
fi

if [ -n "${GOOGLE_SERVICE_INFO_PLIST_B64:-}" ]; then
  PLIST=AlgoMinutes/Resources/GoogleService-Info.plist
  printf '%s' "$GOOGLE_SERVICE_INFO_PLIST_B64" | base64 -D > "$PLIST"
  # A bad value fails here, not deep in the build.
  PROJECT_ID=$(/usr/libexec/PlistBuddy -c "Print :PROJECT_ID" "$PLIST")
  echo "GoogleService-Info.plist for Firebase project: ${PROJECT_ID}"
else
  echo "No GOOGLE_SERVICE_INFO_PLIST_B64: fine for tests (Debug); Staging and Release archives need it."
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  brew install xcodegen
fi
xcodegen generate
