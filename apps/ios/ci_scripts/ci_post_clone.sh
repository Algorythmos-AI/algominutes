#!/bin/sh
# Xcode Cloud (plan PR-30): runs after the clone, before Xcode opens the project.
# See docs/runbooks/xcode-cloud.md for the workflow this expects.
#
#   1. Stamp this build's number (TestFlight needs a new one every upload).
#   2. Write GoogleService-Info.plist from the workflow's secret variable
#      GOOGLE_SERVICE_INFO_PLIST_B64 (base64 of the plist; never committed), and
#      check it's for this app, with the keys the build needs.
#   3. Generate the Xcode project from project.yml with the pinned XcodeGen
#      (it isn't committed).
#   4. Resolve the Swift packages and fail if that changes the committed
#      Package.resolved: Xcode Cloud builds only from it, so it must match
#      project.yml exactly.
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
  # A bad or wrong plist fails here, with its reason, not deep in the build.
  for key in PROJECT_ID BUNDLE_ID CLIENT_ID REVERSED_CLIENT_ID GOOGLE_APP_ID; do
    if ! /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
      echo "error: GoogleService-Info.plist has no $key. Download it again from Firebase (Google sign-in must be on for REVERSED_CLIENT_ID)."
      exit 1
    fi
  done
  BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :BUNDLE_ID" "$PLIST")
  if [ "$BUNDLE_ID" != "com.algorythmos.algominutes" ]; then
    echo "error: GoogleService-Info.plist is for $BUNDLE_ID, not com.algorythmos.algominutes"
    exit 1
  fi
  PROJECT_ID=$(/usr/libexec/PlistBuddy -c "Print :PROJECT_ID" "$PLIST")
  echo "GoogleService-Info.plist for Firebase project: ${PROJECT_ID}"
else
  echo "No GOOGLE_SERVICE_INFO_PLIST_B64: fine for tests (Debug); Staging and Release archives need it."
fi

XCODEGEN=$(sh scripts/install-xcodegen.sh)
"$XCODEGEN" generate

RESOLVED=AlgoMinutes.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
if [ ! -f "$RESOLVED" ]; then
  echo "error: $RESOLVED is missing; it must be committed (see project.yml, packages)"
  exit 1
fi
xcodebuild -resolvePackageDependencies -project AlgoMinutes.xcodeproj -scheme AlgoMinutes
if ! git diff --quiet -- "$RESOLVED"; then
  git --no-pager diff -- "$RESOLVED"
  echo "error: resolving packages changed $RESOLVED; project.yml and the committed Package.resolved disagree"
  exit 1
fi
