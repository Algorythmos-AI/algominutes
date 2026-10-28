#!/usr/bin/env bash
# Runs the app's unit and UI tests on a paired iPhone (over Wi-Fi or a cable) and writes a results folder
# the private test-history repository ingests (docs/runbooks/device-tests.md).
#
#   apps/ios/scripts/device-tests.sh                   # the only paired iPhone, both lanes
#   apps/ios/scripts/device-tests.sh --device ID       # ID: the phone's Identifier in `xcrun devicectl list devices`
#   DEVICE_ID=ID apps/ios/scripts/device-tests.sh      # the same
#   apps/ios/scripts/device-tests.sh --lane ui         # one lane: unit (AlgoMinutesTests), ui (AlgoMinutesUITests)
#                                                      # or guest (the fresh-guest test alone; implies --fresh-guest)
#   apps/ios/scripts/device-tests.sh --only AlgoMinutesTests/StoreBuildTests   # only these (repeatable)
#   apps/ios/scripts/device-tests.sh --check           # the preconditions only
#
#   --keep-dd       keep the build's intermediates (deleted after the run otherwise)
#   --recording     also the tests that record on the phone (RecordingDeviceUITests): each makes a note on
#                   staging, waits for it to be processed and deletes it. They cost staging minutes.
#   --fresh-guest   also, last and in a lane of its own (guest), FreshGuestDeviceUITests: it SIGNS THE PHONE
#                   OUT, records as a brand-new guest, then deletes that guest's account. Sign back in after.
#
# The build goes to DEVICE_TESTS_DERIVED_DATA (default: AlgoMinutes-device-tests in Xcode's DerivedData
# folder); the results to apps/ios/build/device-tests/<date>-<time>-<commit>/ (git-ignored):
# unit.xcresult, ui.xcresult, their <lane>-tests.json and run-info.json. The Debug build talks to staging
# and replaces a TestFlight install of the app. The phone's id and name are never printed or written to
# run-info.json: this repository is public. DEVICE_TESTS_MIN_FREE_GIB (default 5) is the free space asked for.
set -euo pipefail

ios="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ios"

device_id="${DEVICE_ID:-}"
lanes="unit ui"
only=()
keep_dd=0
check_only=0
recording=0
fresh_guest=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --device) device_id="${2:?--device needs the Identifier of the phone from xcrun devicectl list devices}"; shift 2 ;;
    --lane)
      case "${2:-}" in
        unit|ui) lanes="$2" ;;
        guest) lanes=""; fresh_guest=1 ;;
        *) echo "--lane takes unit, ui or guest" >&2; exit 2 ;;
      esac
      shift 2 ;;
    --only) only+=("-only-testing:${2:?--only needs Target, Target/Class or Target/Class/method}"); shift 2 ;;
    --keep-dd) keep_dd=1; shift ;;
    --recording) recording=1; shift ;;
    --fresh-guest) fresh_guest=1; shift ;;
    --check) check_only=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

dd="${DEVICE_TESTS_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/AlgoMinutes-device-tests}"
min_free_gib="${DEVICE_TESTS_MIN_FREE_GIB:-5}"
resolved=AlgoMinutes.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved

# The commit as it is before anything is generated or built: dirty when a tracked file differs, so a run
# never claims a clean commit it did not test.
sha="$(git rev-parse --short HEAD)"
full_sha="$(git rev-parse HEAD)"
dirty=false
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  dirty=true
  echo "warning: the tree differs from $sha (see git status); the run is recorded as dirty" >&2
fi

# 1. Preconditions: every problem at once, each with its fix.
problems=()
problem() { problems+=("$1"); }

xcode_info="$(xcodebuild -version 2>/dev/null || true)"
xcode_version="$(printf '%s\n' "$xcode_info" | sed -n 's/^Xcode //p')"
xcode_build="$(printf '%s\n' "$xcode_info" | sed -n 's/^Build version //p')"
[ -n "$xcode_version" ] || problem "xcodebuild does not run. Install Xcode and select it: sudo xcode-select -s /Applications/Xcode.app"

[ -f AlgoMinutes/Resources/GoogleService-Info.plist ] \
  || problem "AlgoMinutes/Resources/GoogleService-Info.plist is missing. Fetch staging's (apps/ios/.gitignore says how), or copy it from the main checkout."

volume="$dd"
while [ ! -d "$volume" ]; do volume="$(dirname "$volume")"; done
free_gib=$(( $(df -Pk "$volume" | awk 'NR == 2 { print $4 }') / 1024 / 1024 ))
[ "$free_gib" -ge "$min_free_gib" ] \
  || problem "Only $free_gib GiB free where the build goes ($volume); the run needs $min_free_gib GiB. Delete old folders in ~/Library/Developer/Xcode/DerivedData, or set DEVICE_TESTS_DERIVED_DATA to a roomier volume."

# The phone, from devicectl's listing: the named one, or the only paired physical iPhone. Its id stays in
# this shell; only its model, iOS and connection are printed.
udid="" model="" os_version="" transport=""
listing="$(mktemp -t device-tests)"
trap 'rm -f "$listing"' EXIT
if ! xcrun devicectl list devices --json-output "$listing" > /dev/null 2>&1; then
  problem "devicectl cannot list the devices. Run xcodebuild -runFirstLaunch (or open Xcode once), then run again."
elif ! facts="$(python3 -I - "$listing" "$device_id" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
wanted = sys.argv[2]
phones = [d for d in devices if d.get("hardwareProperties", {}).get("platform") == "iOS"
          and d.get("hardwareProperties", {}).get("reality") == "physical"
          and d.get("hardwareProperties", {}).get("deviceType") == "iPhone"]
if wanted:
    phones = [d for d in phones if wanted in (d.get("hardwareProperties", {}).get("udid"), d.get("identifier"))]
    if not phones:
        sys.exit("No paired iPhone has that Identifier: xcrun devicectl list devices shows each phone's.")
elif len(phones) != 1:
    sys.exit(f"{len(phones)} paired iPhones: name one with --device <Identifier> (xcrun devicectl list devices).")
d = phones[0]
h, p, c = d["hardwareProperties"], d.get("deviceProperties", {}), d.get("connectionProperties", {})
errors = []
if c.get("pairingState") != "paired":
    errors.append("The phone is not paired: open Xcode > Window > Devices and Simulators and pair it.")
if p.get("developerModeStatus") != "enabled":
    errors.append("Developer Mode is off: Settings > Privacy & Security > Developer Mode on the phone, then restart it.")
if errors:
    sys.exit("\n".join(errors))
transport = {"localNetwork": "wifi", "wired": "usb"}.get(c.get("transportType"), c.get("transportType") or "unknown")
print(f"udid={h['udid']}\nmodel={h.get('marketingName') or h.get('productType')}\nos={p.get('osVersionNumber')}\ntransport={transport}")
PY
)"; then
  problem "The phone is not ready: see above."
else
  while IFS='=' read -r key value; do
    case "$key" in
      udid) udid="$value" ;; model) model="$value" ;; os) os_version="$value" ;; transport) transport="$value" ;;
    esac
  done <<< "$facts"
  # Xcode installs on a phone only up to its own iOS (iOS 27 needs Xcode 27).
  if [ -n "$xcode_version" ] && [ "${xcode_version%%.*}" -lt "${os_version%%.*}" ]; then
    problem "Xcode $xcode_version cannot test on iOS $os_version: install Xcode ${os_version%%.*} and select it."
  fi
fi

if [ "${#problems[@]}" -gt 0 ]; then
  echo "Not ready to run the tests on the phone:" >&2
  for p in "${problems[@]}"; do echo "  - $p" >&2; done
  exit 1
fi
echo "== Ready: Xcode $xcode_version ($xcode_build), $model on iOS $os_version over $transport, $free_gib GiB free"
echo "== On the phone, before the tests start (none of these can be checked from here):"
echo "   - unlocked, with Settings > Display & Brightness > Auto-Lock set to Never"
echo "   - Settings > Developer > Enable UI Automation on"
echo "   - a Focus (Do Not Disturb) on, so no notification covers the app"
echo "   - on the same Wi-Fi as this Mac, or plugged in"
echo "   The Debug build (staging) replaces the TestFlight app: reinstall it from TestFlight afterwards."
[ "$check_only" = 0 ] || exit 0

# 2. The project, as CI generates it.
stamp="$(date -u +%Y%m%d-%H%M%S)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
start_s="$(date +%s)"
out="$ios/build/device-tests/$stamp-$sha"
mkdir -p "$out" "$dd"
"$(sh scripts/install-xcodegen.sh)" generate --quiet

# Over Wi-Fi the connection to the phone can drop between steps, and xcodebuild then waits for it and gives
# up: asking devicectl about the phone sets it up again, so this runs before each xcodebuild that needs it.
wake_phone() {
  xcrun devicectl device info details --device "$udid" --timeout 60 > /dev/null 2>&1 \
    || echo "warning: devicectl could not reach the phone; xcodebuild will wait for it" >&2
}

# 3. Build for testing once: Debug, automatic signing.
destination="platform=iOS,id=$udid"
common=(-project AlgoMinutes.xcodeproj -scheme AlgoMinutes -destination "$destination" -derivedDataPath "$dd")
wake_phone
echo "== Building for testing (Debug) into $dd"
set +e
xcodebuild build-for-testing "${common[@]}" -configuration Debug \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration > "$out/build.log" 2>&1
build=$?
set -e
if [ "$build" != 0 ]; then
  echo "The build for testing failed ($build). Its errors (all of it in $out/build.log):" >&2
  grep -E 'error:' "$out/build.log" | sort -u | head -20 >&2 || true
  echo "A signing error: check that Xcode > Settings > Accounts is signed in to the team." >&2
  exit 1
fi
if ! git diff --quiet -- "$resolved"; then
  echo "warning: this Xcode rewrote $resolved (not committed; CI's Xcode is the reference)" >&2
fi

# 4. The lanes: unit, then UI with each failed test run again (a pass on the repetition is flaky), then the
# fresh guest, which signs the phone out and so goes last. The opt-in tests read their switch from the test
# runner's environment: xcodebuild hands TEST_RUNNER_<name> to the tests as <name>.
unit_exit="not run" ui_exit="not run" guest_exit="not run"
lane_env=()
[ "$recording" = 0 ] || lane_env+=(TEST_RUNNER_AM_UITEST_RECORDING=1)
run_lane() { # LANE TARGET EXTRA...
  local lane="$1" target="$2"; shift 2
  local selectors=()
  for s in ${only[@]+"${only[@]}"}; do
    case "$s" in "-only-testing:$target"*) selectors+=("$s") ;; esac
  done
  if [ "${#only[@]}" -gt 0 ] && [ "${#selectors[@]}" = 0 ]; then
    return 0
  fi
  [ "${#selectors[@]}" -gt 0 ] || selectors=("-only-testing:$target")
  wake_phone
  echo "== Lane $lane: ${selectors[*]}"
  set +e
  env ${lane_env[@]+"${lane_env[@]}"} xcodebuild test-without-building "${common[@]}" "${selectors[@]}" "$@" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 300 \
    -maximum-test-execution-time-allowance 900 \
    -resultBundlePath "$out/$lane.xcresult" > "$out/$lane.log" 2>&1
  local status=$?
  set -e
  grep -E '^[[:space:]]*Executed [0-9]+ tests?,' "$out/$lane.log" | tail -1 || true
  if [ -f "$out/$lane.xcresult/Info.plist" ]; then
    xcrun xcresulttool get test-results tests --path "$out/$lane.xcresult" > "$out/$lane-tests.json" \
      || echo "warning: could not read the tests of $lane.xcresult" >&2
  else
    echo "warning: lane $lane left no result bundle (see $out/$lane.log); \"UI automation\" in it: turn on Settings > Developer > Enable UI Automation" >&2
  fi
  eval "${lane}_exit=$status"
}
case " $lanes " in *" unit "*) run_lane unit AlgoMinutesTests ;; esac
case " $lanes " in *" ui "*)
  run_lane ui AlgoMinutesUITests -skip-testing:AlgoMinutesUITests/FreshGuestDeviceUITests \
    -retry-tests-on-failure -test-iterations 2 ;;
esac
if [ "$fresh_guest" = 1 ]; then
  lane_env+=(TEST_RUNNER_AM_UITEST_FRESH_GUEST=1)
  run_lane guest AlgoMinutesUITests/FreshGuestDeviceUITests
  echo "   The phone is signed out: open AlgoMinutes and sign in again."
fi

# 5. The record: what the bundles cannot say, for the test-history ingest. Never the phone's id or name,
# never a backend URL (the ingest refuses them).
ci_ios_test="$(gh api "repos/Algorythmos-AI/algominutes/commits/$full_sha/check-runs?check_name=ios-test" \
  --jq '.check_runs[0].conclusion // .check_runs[0].status // "not run"' 2>/dev/null || echo unknown)"
flags=()
[ "$lanes" = "unit ui" ] || flags+=("--lane ${lanes:-guest}")
flags+=(${only[@]+"${only[@]}"})
[ "$recording" = 0 ] || flags+=(--recording)
[ "$fresh_guest" = 0 ] || flags+=(--fresh-guest)
[ "$dirty" = false ] || flags+=(dirty)
RI_COMMIT="$full_sha" RI_TITLE="$(git log -1 --format=%s)" RI_BRANCH="$(git rev-parse --abbrev-ref HEAD)" \
RI_DIRTY="$dirty" RI_XCODE="$xcode_version ($xcode_build)" RI_MODEL="$model" RI_OS="$os_version" \
RI_TRANSPORT="$transport" RI_CI="$ci_ios_test" RI_STARTED="$started_at" RI_SECONDS="$(( $(date +%s) - start_s ))" \
RI_FLAGS="${flags[*]:-none}" RI_UNIT="$unit_exit" RI_UI="$ui_exit" RI_GUEST="$guest_exit" \
python3 -I - "$out/run-info.json" "$dd/Build/Products/Debug-iphoneos/AlgoMinutes.app/Info.plist" <<'PY'
import json, os, plistlib, sys
e = os.environ
app = plistlib.load(open(sys.argv[2], "rb"))
api = app.get("AlgoMinutesAPIBaseURL", "")
# The environment's name from the project number in the API's host, never the URL itself.
backend = "staging" if "-627101926311." in api else "production" if "-43914754953." in api else "unknown"
json.dump({
    "commit": e["RI_COMMIT"], "commit_title": e["RI_TITLE"], "branch": e["RI_BRANCH"],
    "dirty": e["RI_DIRTY"] == "true",
    "xcode": e["RI_XCODE"],
    "device": {"model": e["RI_MODEL"], "os_version": e["RI_OS"], "transport": e["RI_TRANSPORT"]},
    "app": {"version": app.get("CFBundleShortVersionString"), "build": app.get("CFBundleVersion"),
            "configuration": "Debug", "backend": backend},
    "ci_ios_test": e["RI_CI"],
    "started_at": e["RI_STARTED"], "duration_seconds": int(e["RI_SECONDS"]),
    "workflow": "apps/ios/scripts/device-tests.sh",
    "flags": e["RI_FLAGS"],
    "lane_exits": {"unit": e["RI_UNIT"], "ui": e["RI_UI"], "guest": e["RI_GUEST"]},
}, open(sys.argv[1], "w"), indent=2)
PY

# 6. Space: the products stay for a re-run, the intermediates go.
[ "$keep_dd" = 1 ] || rm -rf "$dd/Build/Intermediates.noindex"

echo
echo "== Results: $out"
echo "   Record them: python3 -I tools/ingest_device.py $out (in the private test-history repository)"
for status in "$unit_exit" "$ui_exit" "$guest_exit"; do
  case "$status" in 0|"not run") ;; *) exit 1 ;; esac
done
