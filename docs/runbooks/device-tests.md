# Tests on a real iPhone

`apps/ios/scripts/device-tests.sh` builds the app once and runs its unit tests (`AlgoMinutesTests`) and UI
tests (`AlgoMinutesUITests`) on a paired iPhone, over Wi-Fi or a cable. Every run is then recorded in the
private test-history repository, so what was tested on a phone, on which commit, and with what result can
be looked up later. CI's simulator runs are recorded there too.

## Before a run

On the Mac:

- Xcode at least as new as the phone's iOS (iOS 27 needs Xcode 27). CI builds with an older Xcode on the
  simulator; the run records which Xcode it used.
- `apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist` (staging's; `apps/ios/.gitignore` says how
  to fetch it).
- Xcode › Settings › Accounts signed in to the team: the build signs automatically.
- About 5 GB free for the build (`DEVICE_TESTS_MIN_FREE_GIB`).

On the phone (the script can't check these, so it prints them):

- Paired with this Mac (Xcode › Window › Devices and Simulators) and **Developer Mode** on.
- Unlocked, with **Settings › Display & Brightness › Auto-Lock › Never** for the run.
- **Settings › Developer › Enable UI Automation** on.
- A Focus (Do Not Disturb) on, so no notification covers the app.
- On the same Wi-Fi as the Mac, or plugged in.

The tests run a **Debug** build, which talks to **staging** and replaces the TestFlight app on the phone.
Notes are kept. After the run, reinstall AlgoMinutes from the TestFlight app.

## Run

```bash
apps/ios/scripts/device-tests.sh
```

- `--check`: the preconditions only.
- `--device <Identifier>` (or `DEVICE_ID`): when more than one iPhone is paired (`xcrun devicectl list devices`).
- `--lane unit` or `--lane ui`: one lane.
- `--only AlgoMinutesTests/StoreBuildTests`: only these tests (repeatable).
- `--keep-dd`: keep the build's intermediates, for a faster re-run.
- `--recording`: also the tests that record (see below).
- `--fresh-guest`: also the fresh-guest test, last (see below). **It signs the phone out.**

The build goes to `~/Library/Developer/Xcode/DerivedData/AlgoMinutes-device-tests`
(`DEVICE_TESTS_DERIVED_DATA`). The results go to `apps/ios/build/device-tests/<date>-<time>-<commit>/`
(git-ignored): `unit.xcresult`, `ui.xcresult`, `<lane>-tests.json`, the logs and `run-info.json`. A failed
UI test runs once more; a pass the second time counts as flaky. The script exits non-zero when a lane
fails.

The phone's identifier and name are never printed or written to `run-info.json`, because this repository
is public. The xcodebuild logs in the results folder do name the phone, so they stay on the Mac.

## Tests that record

Off unless asked for, because they make real notes on staging and cost its minutes. The microphone hears
whatever is in the room, so a quiet room makes a note with little in it: the tests ask only that the note is
processed (Ready, or Couldn't process), never stuck. Each deletes what it made, whatever the outcome.

- `--recording` (`RecordingDeviceUITests`, on the account the phone is signed in to): a 15-second recording,
  paused and resumed, minimised and opened again from the recording bar, then ended. The note must be
  processed within 10 minutes, then it's deleted from the note's More operations.
- `--fresh-guest` (`FreshGuestDeviceUITests`, in a lane of its own, `guest`, after the others): the app is
  launched with `-AMUITestFreshGuest`, which **signs out whoever is on the phone** and starts as a brand-new
  guest, as on a first install. The guest records a 10-second note without signing in, then deletes their
  account with both confirmations. It deletes only the guest it made (it checks the User ID first), and the
  launch refuses to sign out while a recording waits to upload, because signing out would delete it.
  Afterwards the app is on the sign-in screen: sign in again (Settings › Create account, then your existing
  account).

The launch arguments (`-AMUITestFreshGuest`, `-AMUITestClientVersion`) are read only by Debug builds
(`UITestHooks`); TestFlight and App Store builds ignore them.

## Record the run

In the private test-history repository, `tools/ingest_device.py` takes the results folder, checks it for
anything private, and writes the run and each test's result (with failed UI tests' screenshots, except
screens that show notes or recordings). Its README has the steps, and how to record the hand-run checks
(Sign in with Apple, a real call, VoiceOver, long recordings) on the same run.

Before chasing a failing test, ask the history whether it failed or was flaky before, and since which
commit.

## When it goes wrong

| Symptom | Fix |
|---|---|
| "Not ready to run the tests on the phone" | Each line names its fix. |
| The UI lane leaves no result bundle, or its log mentions UI automation | Settings › Developer › Enable UI Automation, and unlock the phone. |
| "The tunnel was interrupted" over Wi-Fi | Run again, or plug the phone in. The script wakes the connection before each step. |
| A signing error | Xcode › Settings › Accounts: sign in to the team; open the project once in Xcode. |
| "this Xcode rewrote Package.resolved" | Expected with a newer Xcode than CI's. Don't commit it: `git checkout` the file. |
