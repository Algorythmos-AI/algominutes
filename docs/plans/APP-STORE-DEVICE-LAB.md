# Device lab: an always-on iPhone 11 Pro Max

**Draft for the owner, 2026-10-29.** Checked against `origin/integration` at aa7a8e38. The phone is set up and
the test lanes run green on it by hand; the scheduled lab (the wrapper and the LaunchAgent below) is a plan,
not built. It serves I6 ("every iOS change unverified on a device", RELEASE.md R12.3) and device passes 1 and 2
(R12.5).

## Where it stands [measured, 2026-10-28/29]

- **The phone.** A dedicated iPhone 11 Pro Max on **iOS 27.0.1**, paired over **USB**, Developer Mode on.
  The Mac runs **Xcode 27.0**. Provisioning profiles were regenerated on 2026-10-28 and include it. The iPhone
  17 Pro Max is **no longer paired** with this Mac.
- **The script** [code]: `apps/ios/scripts/device-tests.sh` with lanes `unit`, `ui`, `guest`, and
  `--recording`, `--fresh-guest`, `--release` (Release build against production, UI tests only; merged in
  #523). On Xcode 27.0, `--release` only builds with its own scheme `AlgoMinutes-ReleaseUITests`: **#528**, open
  (it may be in the merge queue). It asks for 5 GiB free (`DEVICE_TESTS_MIN_FREE_GIB`), writes
  `apps/ios/build/device-tests/<stamp>-<sha>/`, prints `== Results: <folder>`, and exits non-zero when a lane
  or a precondition fails. Every run is recorded in the private test-history repository
  (`docs/runbooks/device-tests.md`).
- **Overnight results on the iPhone 11:** the full UI lane green 4 times (9 passed, 1 opt-in skip); the unit
  lane green 3 times (432 passed); the fresh-guest lane green; the Release lane against production green after
  the fixes (#528's scheme, #530's delete-sheet test): 8 passed, 0 flaky. **The recording test skipped**: the
  staging app on the phone was on a guest, and it needs a signed-in account with minutes (§1, the lab account).
- `IPHONEOS_DEPLOYMENT_TARGET` is 17.0 (`apps/ios/project.yml`), so iOS 27 is fine.

## Owner decisions (defaults in bold)

- **D1. Weekly fresh-guest run: off.** It signs the phone out, so later `--recording` runs skip until someone
  signs back in, and staging gives new guests no minutes.
- **D2. The lab account: a new Google account used for nothing else** (needs no Apple ID on the phone), rather
  than Sign in with Apple on a lab Apple ID.
- **D3. No passcode on the lab phone**, so it never sits locked after a reboot. It holds only the lab account.
- **D4. Keep the Mac awake on power always**; alternatives: a scheduled wake at 01:55, or neither (runs only
  while awake).
- **D5. What to delete to free about 10 GiB** on the Mac. The lab only ever deletes its own files.
- **D6. The Release lane on production:** it may create a guest and a device token there on each run (not
  verified). **Accept that, and never schedule it**; a person starts it before a submission.
- **D7. Every device run goes through `device-lab.sh run` and its lock**, scheduled or by hand, so two runs
  never share the phone.
- **D8. Red runs are reported as issues in the private test-history repository**, plus a macOS notification;
  no e-mail or messages beyond GitHub's own notifications.
- **D9. Nightly at 02:00 local; a test flaky in 3 lab runs gets an issue.**

## 1. The owner's one-time setup

### The phone (done items marked)

- [x] Paired over USB, Developer Mode on, in the regenerated profiles.
- [x] iOS 27.0.1 (Xcode 27.0 supports it).
- [ ] Holds nothing of the owner's; no Apple ID, or a dedicated lab Apple ID (not verified).
- [ ] Settings › Developer › Enable UI Automation on (implied by the green UI lanes, not separately checked).
- [ ] Auto-Lock Never; Do Not Disturb on with no end; Automatic Updates off; Show Previews Never; no widgets
      or Live Activities; lowest brightness and a black wallpaper (OLED).
- [ ] Passcode off (D3).
- [ ] Wi-Fi on as well as the cable: the app needs the internet to reach staging.
- [ ] Optimized Battery Charging on.

### The staging lab account (unblocks the recording test)

1. A dedicated Google account for the lab (D2).
2. An invite code with minutes: `scripts/new-invite-code.sh`, registered by the owner with `INVITE_MINUTES=600`
   and `INVITE_USES=1`. Staging gives new guests no minutes, so the recording test needs it.
3. In the lab's Debug build on the phone: sign in with that account, then redeem the code. A sign-in made in a
   TestFlight build isn't the Debug build's (`docs/runbooks/device-tests.md`).
4. Keep the account's address out of git: add it to the history repository's privacy deny list (its README
   gives the path), together with the iPhone 11's name and identifier.

### The Mac

1. Free disk first (D5): at least 7 GiB free before each run (5 for the build, 2 for results and logs). Pairing
   to a new iOS version copies 2–4 GB of symbols into `~/Library/Developer/Xcode/iOS DeviceSupport`; keep that
   folder, since the lab phone uses it.
2. Python 3.10 or later on the PATH ahead of `/usr/bin/python3` (the history tools need it).
3. `gh` signed in with push and issue rights on the private test-history repository.
4. The lab's own checkouts, never the owner's working checkout:

   ```sh
   mkdir -p ~/algominutes-lab/bin ~/Library/Logs/algominutes-lab
   git clone --filter=blob:none --branch integration <app repo> ~/algominutes-lab/app
   git clone <private test-history repository> ~/algominutes-lab/test-history
   cp <main checkout>/apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist \
      ~/algominutes-lab/app/apps/ios/AlgoMinutes/Resources/   # staging's
   ```

5. `~/.config/algominutes-lab/lab.env`, mode 600, never committed (§3).
6. Keep the Mac awake on power (D4): System Settings › Battery › Options › "Prevent automatic sleeping on power
   adapter when the display is off", or `sudo pmset -c sleep 0` (the owner runs it). The login keychain must
   stay unlocked while the screen is locked (the default), or signing fails.
7. Stay logged in: a LaunchAgent runs only in the logged-in session.

## 2. The schedule

One launchd tick every 15 minutes decides what to run (Mac local time).

| What | When | Flags | Why | Staging cost [estimated] |
|---|---|---|---|---|
| Merge run | Within 15 min of a new `integration` tip (newest only) | default lanes (unit, ui) | Every merge proved on a real phone the day it lands | ~$0 |
| Nightly | First tick after 02:00 | default lanes + `--recording` | The one end-to-end proof: record, upload, process on staging, delete | 1 recording, ~$0.03–0.05 |
| Weekly fresh guest | Off (D1); if on, Sunday after 04:00 | `--lane guest` | First launch as a new guest, and account deletion | 1 guest, 1 short recording |
| Release check | Never scheduled; by hand before a submission | `--release` (UI only) | The Release build against production | Production: possibly a guest and a token (D6) |
| Clean build | Sunday's nightly | nightly after deleting the lab's DerivedData | An incremental build can hide a broken clean one | $0 |

About $1.50–2 a month [estimated]. A merge run is 5–15 minutes; a busy train becomes at most one run per tick,
always on the newest tip.

## 3. The mechanism

| File | In git? | What |
|---|---|---|
| `apps/ios/scripts/device-lab.sh` | yes | The wrapper. Generic: no device ids, no repository names, no addresses (those come from `lab.env`) |
| `apps/ios/scripts/device-lab.plist.template` | yes | The LaunchAgent, `__HOME__` for the home folder |
| `docs/runbooks/device-lab.md` | yes | Setup, pause, status, retiring a phone |
| `~/algominutes-lab/bin/device-lab.sh` | no | The copy launchd runs, refreshed only by `install-self`, so a merge never swaps the running wrapper |
| `~/.config/algominutes-lab/lab.env` | no, 600 | Device id, the history repository's slug, limits |
| `~/Library/LaunchAgents/com.algorythmos.algominutes.device-lab.plist` | no | The installed agent |
| `~/Library/Application Support/algominutes-lab/` | no | Lock, last tested sha, last nightly, pending ingests, recording counts, pause flag |
| `~/Library/Logs/algominutes-lab/` | no | One log per run, 14 days; they name the phone, so they stay on the Mac |

`lab.env` (example; the real one is local):

```sh
LAB_DEVICE_ID=""                       # the iPhone 11's Identifier from: xcrun devicectl list devices
LAB_EXPECT_MODEL="iPhone 11 Pro Max"   # a run on any other phone is refused
LAB_APP="$HOME/algominutes-lab/app"
LAB_HISTORY="$HOME/algominutes-lab/test-history"
LAB_ISSUE_REPO=""                      # owner/name of the private test-history repository
LAB_SINCE="2026-11-01"                 # the lab's first day: flaky counts start here
LAB_NIGHTLY_HOUR=2
LAB_WEEKLY_GUEST=0                     # D1
LAB_GUEST_HOUR=4
LAB_MIN_FREE_GIB=7
LAB_MAX_RECORDINGS_PER_DAY=3
LAB_RUN_LIMIT_MIN=120                  # a run longer than this is killed
LAB_STAGING_PROJECT="algominutes-staging"
LAB_FLAKY_THRESHOLD=3                  # D9
```

<details>
<summary>The proposed wrapper, <code>apps/ios/scripts/device-lab.sh</code> (lands in its own PR)</summary>

```bash
#!/usr/bin/env bash
# The device lab: runs device-tests.sh on the lab iPhone on a schedule, records each run in the private
# test-history repository and reports red runs (docs/runbooks/device-lab.md).
#
#   device-lab.sh tick                 # launchd, every 15 min: the nightly, the weekly guest or a merge run
#   device-lab.sh run [--ref R] [FLAGS] # now, under the lock: R (default origin/integration), device-tests FLAGS
#   device-lab.sh release              # the Release build against production (--release), by hand only
#   device-lab.sh status               # lock, pause, last runs, disk
#   device-lab.sh pause | resume       # stop or restart scheduled runs (a run in progress finishes)
#   device-lab.sh install-self         # copy this script to ~/algominutes-lab/bin (what launchd runs)
#
# Config: ~/.config/algominutes-lab/lab.env (never committed). Works with macOS's bash 3.2.
# Never prints the phone's id or name, an e-mail address or a backend URL.
set -euo pipefail

conf="${LAB_CONF:-$HOME/.config/algominutes-lab/lab.env}"
[ -f "$conf" ] || { echo "no $conf (docs/runbooks/device-lab.md)" >&2; exit 2; }
# shellcheck disable=SC1090
. "$conf"
: "${LAB_DEVICE_ID:?set LAB_DEVICE_ID in $conf}" "${LAB_ISSUE_REPO:?set LAB_ISSUE_REPO in $conf}"
: "${LAB_APP:=$HOME/algominutes-lab/app}" "${LAB_HISTORY:=$HOME/algominutes-lab/test-history}"
: "${LAB_EXPECT_MODEL:=iPhone 11 Pro Max}" "${LAB_SINCE:=2026-11-01}"
: "${LAB_NIGHTLY_HOUR:=2}" "${LAB_WEEKLY_GUEST:=0}" "${LAB_GUEST_HOUR:=4}"
: "${LAB_MIN_FREE_GIB:=7}" "${LAB_MAX_RECORDINGS_PER_DAY:=3}" "${LAB_RUN_LIMIT_MIN:=120}"
: "${LAB_STAGING_PROJECT:=algominutes-staging}" "${LAB_FLAKY_THRESHOLD:=3}"

state="$HOME/Library/Application Support/algominutes-lab"
logs="$HOME/Library/Logs/algominutes-lab"
ios="$LAB_APP/apps/ios"
results="$ios/build/device-tests"
dd="$HOME/Library/Developer/Xcode/DerivedData/AlgoMinutes-device-tests"
plist="$ios/AlgoMinutes/Resources/GoogleService-Info.plist"
mkdir -p "$state" "$logs"
today="$(date +%Y%m%d)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
notify() { osascript -e "display notification \"$1\" with title \"AlgoMinutes device lab\"" >/dev/null 2>&1 \
  || log "warning: could not show a notification"; }
free_gib() { echo $(( $(df -Pk "$HOME" | awk 'NR == 2 { print $4 }') / 1024 / 1024 )); }

# --- The lock: one run at a time, scheduled or by hand. A lock whose process is gone is stale.
lock="$state/lock"
take_lock() {
  if mkdir "$lock" 2>/dev/null; then echo $$ > "$lock/pid"; trap 'rm -rf "$lock"' EXIT; return 0; fi
  local other; other="$(cat "$lock/pid" 2>/dev/null || echo "")"
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    log "a run is in progress (pid $other): not starting another"; return 1
  fi
  log "stale lock (pid ${other:-none} is gone): taking it"
  rm -rf "$lock"; mkdir "$lock"; echo $$ > "$lock/pid"; trap 'rm -rf "$lock"' EXIT
}

# --- A time limit (macOS has no `timeout`): the command runs in its own process group, killed whole.
run_limited() { # MINUTES CMD...
  local minutes="$1"; shift
  set -m
  "$@" & local pid=$!
  ( sleep $(( minutes * 60 )); log "run over ${minutes} min: stopping it"
    kill -TERM -- "-$pid" 2>/dev/null; sleep 60; kill -KILL -- "-$pid" 2>/dev/null ) & local dog=$!
  set +m
  local status=0
  wait "$pid" || status=$?
  kill -- "-$dog" 2>/dev/null || log "the time-limit watcher had already ended"
  return "$status"
}

# --- Issues in the private test-history repository: one open issue per kind, commented, closed when fixed.
issue_open() { # KEY TITLE BODY
  local key="$1" title="$2" body="$3" num
  num="$(gh issue list -R "$LAB_ISSUE_REPO" --label device-lab --state open --search "\"[$key]\" in:title" \
    --json number --jq '.[0].number // empty' 2>/dev/null || echo "")"
  if [ -n "$num" ]; then
    gh issue comment "$num" -R "$LAB_ISSUE_REPO" --body "$body" >/dev/null || log "warning: could not comment on issue $num"
  else
    gh issue create -R "$LAB_ISSUE_REPO" --label device-lab --title "[$key] $title" --body "$body" >/dev/null \
      || log "warning: could not open the issue [$key]"
  fi
  notify "$title"
}
issue_close() { # KEY BODY
  local num
  num="$(gh issue list -R "$LAB_ISSUE_REPO" --label device-lab --state open --search "\"[$1]\" in:title" \
    --json number --jq '.[0].number // empty' 2>/dev/null || echo "")"
  [ -z "$num" ] || gh issue close "$num" -R "$LAB_ISSUE_REPO" --comment "$2" >/dev/null \
    || log "warning: could not close issue $num"
}

# --- Guards before any run.
guard_disk() {
  local f; f="$(free_gib)"
  if [ "$f" -lt "$LAB_MIN_FREE_GIB" ]; then
    rm -rf "$dd/Build/Intermediates.noindex"; prune_results
    f="$(free_gib)"
  fi
  if [ "$f" -lt "$LAB_MIN_FREE_GIB" ]; then
    issue_open disk "The lab Mac is short of disk" "Only $f GiB free; the lab needs $LAB_MIN_FREE_GIB. No run started. The lab deletes only its own build and results; the rest is the owner's call."
    return 1
  fi
}
guard_staging_plist() { # the Debug build must talk to staging
  local project
  project="$(/usr/libexec/PlistBuddy -c 'Print :PROJECT_ID' "$plist" 2>/dev/null || echo missing)"
  if [ "$project" != "$LAB_STAGING_PROJECT" ]; then
    touch "$state/paused"
    issue_open prod-guard "The lab is paused: the app's Firebase config is not staging's" "GoogleService-Info.plist in the lab checkout names project '$project', not staging. The lab paused itself. Put staging's back, then: device-lab.sh resume"
    return 1
  fi
}
guard_phone() { # the pinned phone, ready, and the expected model
  local out
  if ! out="$(cd "$ios" && scripts/device-tests.sh --device "$LAB_DEVICE_ID" --check 2>&1)"; then
    local misses; misses=$(( $(cat "$state/phone-misses" 2>/dev/null || echo 0) + 1 ))
    echo "$misses" > "$state/phone-misses"
    log "the phone is not ready ($misses in a row)"
    # three ticks in a row (45 min) before anyone is told: a reboot or a cable wiggle heals itself
    [ "$misses" -lt 3 ] || issue_open phone "The lab phone is not ready" \
      "device-tests.sh --check failed $misses times in a row. Check the cable, that the phone is on and unlocked, Developer Mode and UI Automation. The full message is in the lab log on the Mac."
    return 1
  fi
  rm -f "$state/phone-misses"
  if ! printf '%s\n' "$out" | grep -q "== Ready: .*, $LAB_EXPECT_MODEL on iOS"; then
    issue_open phone "The pinned phone is not the lab phone" "The phone the lab is pinned to is not a $LAB_EXPECT_MODEL. No run started."
    return 1
  fi
  issue_close phone "The phone is ready again."
}
recordings_today() { cat "$state/recordings-$today" 2>/dev/null || echo 0; }

# --- The lab checkout at a ref: always clean, always the same as the remote.
checkout() { # REF
  git -C "$LAB_APP" fetch -q origin integration
  git -C "$LAB_APP" checkout -q --detach --force "$1"
  git -C "$LAB_APP" reset -q --hard
}

# --- Record the run in the history repository; anything not pushed stays pending and is pushed next time.
ingest_and_push() { # FOLDER
  echo "$1" >> "$state/pending"
  ( cd "$LAB_HISTORY"
    git fetch -q origin main
    git checkout -q main
    git reset -q --hard origin/main      # this clone only ever holds lab commits, all re-made below
    while IFS= read -r folder; do
      [ -d "$folder" ] || continue
      python3 -I tools/ingest_device.py "$folder" --force
    done < "$state/pending"
    python3 -I tools/validate.py
    python3 -I tools/privacy.py check
    git add runs index
    git diff --cached --quiet || git commit -q -m "data: device run $(basename "$1")"
    git push -q origin main )
  : > "$state/pending"
}

# --- Space: the lab's own results only. Keep the newest green and the newest 3 red folders.
prune_results() {
  [ -d "$results" ] || return 0
  grep -qs . "$state/pending" && return 0     # never delete what is not pushed yet
  local keep; keep="$( (ls -1t "$state"/green-* 2>/dev/null | head -1; ls -1t "$state"/red-* 2>/dev/null | head -3) \
    | sed 's|.*/[a-z]*-||')"
  for f in "$results"/*; do
    [ -d "$f" ] || continue
    printf '%s\n' "$keep" | grep -qx "$(basename "$f")" || rm -rf "$f"
  done
  find "$logs" -name '*.log' -mtime +14 -delete
}

# --- One run: checkout, device-tests.sh, guards on the result, ingest, report.
one_run() { # KIND REF FLAGS...
  local kind="$1" ref="$2"; shift 2
  local flags=("$@") runlog status=0 folder sha
  case " ${flags[*]-} " in *" --recording "*|*" --lane guest "*|*" --fresh-guest "*)
    if [ "$(recordings_today)" -ge "$LAB_MAX_RECORDINGS_PER_DAY" ]; then
      log "already $(recordings_today) recordings today (limit $LAB_MAX_RECORDINGS_PER_DAY): not recording"
      return 0
    fi ;;
  esac
  case " ${flags[*]-} " in *" --release "*)
    case " ${flags[*]} " in *" --recording "*|*" --fresh-guest "*|*" --lane guest "*)
      log "--release never records or makes accounts on production: refused"; return 2 ;; esac ;;
  esac
  checkout "$ref"
  sha="$(git -C "$LAB_APP" rev-parse --short HEAD)"
  case " ${flags[*]-} " in *" --release "*) ;; *) guard_staging_plist || return 1 ;; esac
  guard_disk || return 1
  guard_phone || return 1
  runlog="$logs/$(date +%Y%m%d-%H%M%S)-$kind-$sha.log"
  log "$kind run on $sha (${flags[*]-default lanes}); log: $runlog"
  caffeinate -i -s -w $$ &
  ( cd "$ios" && run_limited "$LAB_RUN_LIMIT_MIN" \
      env DEVICE_TESTS_MIN_FREE_GIB=5 scripts/device-tests.sh --device "$LAB_DEVICE_ID" ${flags[@]+"${flags[@]}"} ) \
    > "$runlog" 2>&1 || status=$?
  case " ${flags[*]-} " in *" --recording "*|*" --lane guest "*|*" --fresh-guest "*)
    echo $(( $(recordings_today) + 1 )) > "$state/recordings-$today" ;; esac
  folder="$(sed -n 's/^== Results: //p' "$runlog" | tail -1)"

  # The staging plist must be back after a --release run, and a Debug run must have talked to staging.
  case " ${flags[*]-} " in *" --release "*) guard_staging_plist || return 1 ;; esac
  if [ -n "$folder" ] && [ -f "$folder/run-info.json" ]; then
    local backend; backend="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["app"]["backend"])' "$folder/run-info.json")"
    case " ${flags[*]-} " in *" --release "*) ;; *)
      if [ "$backend" != staging ]; then
        touch "$state/paused"
        issue_open prod-guard "The lab is paused: a Debug run did not talk to staging" "Run on $sha recorded backend '$backend'. Nothing is ingested. Find out why, then: device-lab.sh resume"
        return 1
      fi ;;
    esac
  else
    # No results: the build or the phone failed before the tests. Not ingested (nothing to ingest).
    issue_open lab "The lab could not test $sha" "device-tests.sh ended with $status before any test ran ($kind run). The build log and the run log are on the Mac under ~/Library/Logs/algominutes-lab; they name the phone, so they are not posted here."
    return 1
  fi

  if ! ingest_and_push "$folder"; then
    issue_open history "A lab run could not be recorded" "Ingest, validation, the privacy check or the push failed for $(basename "$folder"). It stays pending and is retried after the next run. A privacy refusal is never bypassed."
  fi
  issue_close lab "The lab tested $sha."

  local id; id="$(basename "$folder")"
  if [ "$status" = 0 ]; then
    touch "$state/green-$id"
    issue_close "red-$kind" "Green again on $sha (run $id)."
  else
    touch "$state/red-$id"
    local failed; failed="$(python3 -I - "$LAB_HISTORY" "$id" <<'PY'
import json, pathlib, sys
root, run = pathlib.Path(sys.argv[1]), sys.argv[2]
for path in root.glob(f"runs/device/*/{run}/tests.jsonl"):
    for line in path.read_text().splitlines():
        t = json.loads(line)
        if t.get("status") == "failed":
            print(f"- {t.get('lane')}: {t.get('id')}")
PY
)"
    issue_open "red-$kind" "Red on the lab phone: $kind run" "Run $id on $sha (${flags[*]-default lanes}).

Failed:
${failed:-(no test failed: a lane exited non-zero; see the run in the history)}

Before chasing it: python3 -I tools/query.py first-failure <test> --branch integration"
  fi
  flaky_report
  prune_results
  return "$status"
}

# --- Flaky policy: report, never skip. A test flaky in LAB_FLAKY_THRESHOLD lab runs gets an issue.
flaky_report() {
  ( cd "$LAB_HISTORY" && python3 -I tools/query.py --json flaky -n 50 --since "$LAB_SINCE" --kind device ) \
    | python3 -I -c '
import json, sys
for t in json.load(sys.stdin):
    if t["flaky"] >= int(sys.argv[1]):
        print(t["test"] + "\t" + str(t["flaky"]) + "\t" + str(t["runs"]))' "$LAB_FLAKY_THRESHOLD" \
    | while IFS="$(printf '\t')" read -r test flaky runs; do
        issue_open "flaky $test" "Flaky on the lab phone: $test" \
          "Flaky in $flaky of $runs lab runs since $LAB_SINCE. Fix the test or the code; do not skip it."
      done
}

# --- What a tick runs, in order of priority.
tick() {
  [ ! -f "$state/paused" ] || { log "paused"; return 0; }
  take_lock || return 0
  local hour dow last tip
  hour="$(date +%H)"; hour=$((10#$hour)); dow="$(date +%u)"
  if [ "$hour" -ge "$LAB_NIGHTLY_HOUR" ] && [ "$(cat "$state/last-nightly" 2>/dev/null)" != "$today" ]; then
    echo "$today" > "$state/last-nightly"
    [ "$dow" != 7 ] || { log "Sunday: clean build"; rm -rf "$dd"; }
    one_run nightly origin/integration --recording || log "nightly run ended non-zero"
    return 0
  fi
  if [ "$LAB_WEEKLY_GUEST" = 1 ] && [ "$dow" = 7 ] && [ "$hour" -ge "$LAB_GUEST_HOUR" ] \
     && [ "$(cat "$state/last-guest" 2>/dev/null)" != "$today" ]; then
    echo "$today" > "$state/last-guest"
    one_run guest origin/integration --lane guest || log "guest run ended non-zero"
    issue_open signed-out "Sign the lab phone back in" "The weekly fresh-guest run signed the phone out. Recording runs skip until the lab account signs in again."
    return 0
  fi
  git -C "$LAB_APP" fetch -q origin integration
  tip="$(git -C "$LAB_APP" rev-parse origin/integration)"
  last="$(cat "$state/last-tested" 2>/dev/null || echo none)"
  if [ "$tip" != "$last" ]; then
    echo "$tip" > "$state/last-tested"     # set first: a commit that wedges the lab is not retried forever
    one_run merge "$tip" || log "merge run ended non-zero"
  fi
}

case "${1:-}" in
  tick) tick ;;
  run)
    shift; ref=origin/integration
    if [ "${1:-}" = --ref ]; then ref="origin/${2:?--ref needs a branch}"; shift 2; fi
    case " $* " in *" --release "*) echo "use: device-lab.sh release" >&2; exit 2 ;; esac
    take_lock || exit 1
    one_run manual "$ref" "$@" ;;
  release)
    printf 'This builds Release against PRODUCTION and runs the UI tests. Type "production" to go on: '
    read -r answer; [ "$answer" = production ] || { echo "not run"; exit 1; }
    take_lock || exit 1
    one_run release origin/integration --release --lane ui ;;
  status)
    [ -f "$state/paused" ] && echo "paused" || echo "running on schedule"
    [ -d "$lock" ] && echo "a run is in progress (pid $(cat "$lock/pid" 2>/dev/null))" || echo "idle"
    echo "last tested: $(cat "$state/last-tested" 2>/dev/null || echo none)"
    echo "last nightly: $(cat "$state/last-nightly" 2>/dev/null || echo none); recordings today: $(recordings_today)"
    echo "pending ingests: $(grep -c . "$state/pending" 2>/dev/null || echo 0); free: $(free_gib) GiB"
    ( cd "$LAB_HISTORY" && python3 -I tools/query.py runs -n 5 --kind device ) ;;
  pause) touch "$state/paused"; echo "paused" ;;
  resume) rm -f "$state/paused"; echo "resumed" ;;
  install-self) install -m 755 "$0" "$HOME/algominutes-lab/bin/device-lab.sh"; echo "installed" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
```
</details>

Design notes:
- One run at a time: a `mkdir` lock covers launchd ticks and manual runs (D7). A lock whose pid is gone is
  stale and taken over.
- `last-tested` is written before the run, so a commit that hangs the lab is tested once, not every tick.
- The history clone is reset to its remote and every pending run re-ingested before each commit, so a race
  with another ingest never leaves a conflict. A privacy refusal is never bypassed: the run stays pending.
- Every failure is logged or reported (`|| log …`, `|| status=$?`); no silent catches.
- `shellcheck` clean; runs under macOS `/bin/bash` 3.2 (no associative arrays, no `mapfile`).
- `release` refuses `--recording` and `--fresh-guest`: the lab never records or makes accounts on production
  beyond what the UI lane does (D6). `device-tests.sh` itself allows `--release --recording`; the lab doesn't
  use it.

<details>
<summary>The proposed LaunchAgent, <code>apps/ios/scripts/device-lab.plist.template</code></summary>

Installed by the owner with `sed "s|__HOME__|$HOME|g"` into `~/Library/LaunchAgents/`, then `launchctl
bootstrap gui/$(id -u) <file>`; removed with `launchctl bootout gui/$(id -u)/com.algorythmos.algominutes.device-lab`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.algorythmos.algominutes.device-lab</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__HOME__/algominutes-lab/bin/device-lab.sh</string>
    <string>tick</string>
  </array>

  <!-- Every 15 minutes. Ticks missed while the Mac slept run once on wake. -->
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <false/>

  <!-- A LaunchAgent, not a daemon: signing needs the owner's login keychain, devicectl the user session. -->
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Standard</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>__HOME__/algominutes-lab</string>
  <key>StandardOutPath</key>
  <string>__HOME__/Library/Logs/algominutes-lab/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>__HOME__/Library/Logs/algominutes-lab/launchd.log</string>

  <!-- On bootout, give a run a minute to stop. -->
  <key>ExitTimeOutSeconds</key>
  <integer>60</integer>
</dict>
</plist>
```
</details>

Staying awake: during a run, `caffeinate -i -s -w $$` in the wrapper; between runs, D4.

## 4. Failures

- **Issues in the private test-history repository**, label `device-lab`, never in the public app repo. One open
  issue per kind (`[red-merge]`, `[red-nightly]`, `[red-guest]`, `[red-release]`, `[lab]`, `[phone]`, `[disk]`,
  `[history]`, `[prod-guard]`, `[flaky <test>]`, `[signed-out]`); a repeat comments, the next green closes it.
- Each holds the run id, short sha, flags and failed test ids. Never the phone's name or id, a log excerpt
  (xcodebuild logs name the phone), an address or a backend URL.
- **Flaky tests:** `device-tests.sh` reruns a failed UI test once; a second-time pass is "flaky" and the run is
  green. Across runs, the history's flaky query since `LAB_SINCE`; 3 or more opens an issue. The lab never
  skips, quarantines or reruns a whole run to turn it green. A test flaky only on the A13 phone is a real
  finding. Before chasing a red test, ask the history when it first failed.

## 5. Safety

The lab must never:
- **Sign in as, or sign out, the owner.** The phone holds only the lab account; the wrapper refuses any phone
  that isn't the pinned id and the expected model.
- **Touch production**, except `device-lab.sh release`, started by a person who types "production"; never
  scheduled, never with `--recording` or `--fresh-guest`. Before every other run the plist must name staging's
  project; after it, `run-info.json` must say `staging`; either failing pauses the lab. After a release run
  staging's plist must be back (`device-tests.sh` restores it in a trap), or the lab pauses.
- **Delete anything but its own**: its DerivedData folder, its pushed result folders, its logs over 14 days.
  Never other DerivedData, iOS DeviceSupport, simulators, or the owner's checkouts.
- **Push anything but data commits** to the history repository's main branch; never the app repo.
- **Hold secrets in git**: `lab.env`, the deny list and the Firebase plists stay local.

Disk: at least 7 GiB free before a run, else it clears its own intermediates and old results, checks again,
and opens `[disk]` instead of running. Keeps the newest green and the newest 3 red result folders; never
deletes anything pending.

Cost: at most 3 recording runs a day, manual ones included; only the nightly records; the lab account's 600
invite minutes cap total spend (a red issue shows when they run out).

iOS updates: Automatic Updates off; the owner updates the lab phone by hand once Xcode supports the new iOS,
and frees disk for its symbols first.

## 6. Order of work

1. Owner: the phone checklist (§1), the lab account and invite code, ~10 GiB free (D5). The iPhone 17 is
   already unpaired; if it was used for device runs, also clear Trusted Computers on it (Settings › Developer).
2. #528 merged, so `--release` builds on Xcode 27.0.
3. A PR to `integration`: `device-lab.sh`, `device-lab.plist.template`, `docs/runbooks/device-lab.md`;
   `shellcheck` clean; one concern. Update `docs/runbooks/device-tests.md` to say manual runs go through
   `device-lab.sh run`.
4. Owner: clone the lab checkouts, write `lab.env`, `install-self`; two manual runs green and recorded
   (`device-lab.sh run`, then `device-lab.sh run --recording`, which is the first recording proof).
5. Owner: install the LaunchAgent; watch the first nightly.
6. After a week: read the flaky report and decide D1.

## Not verified

- The phone checklist items not ticked in §1.
- The wrapper and LaunchAgent: never run; `shellcheck` not run on them.
- Cost and run-time figures (estimated from the earlier iPhone 17 runs, 4.4–5.6 minutes warm).
- That the Release lane's guest and token on production are all it creates (D6).
