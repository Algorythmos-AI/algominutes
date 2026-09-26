# Internal TestFlight (plan S1-PR9)

Internal testing runs on **staging** (`algominutes-staging`), built by the Xcode Cloud workflow
**Staging → Internal** (`xcode-cloud.md`). Internal builds skip Beta App Review and reach testers once
processed. The first part is for testers; the rest is for whoever runs the beta.

## For testers

### Install

1. Accept the email invite to the App Store Connect team, then the TestFlight invite for AlgoMinutes.
2. Install **TestFlight** from the App Store, open it, and install AlgoMinutes.
3. You need an iPhone on iOS 17 or later. (The app is iPhone-only for now.)

### First launch

- You start as a **guest**: no sign-up. A guest's notes belong to that guest account only. To keep
  them, use **Settings → Create account** (Apple or Google): your notes move with you. Signing out as
  a guest deletes them, and the app says so first.
- **Minutes are switched on by hand.** Before your first recording, open **Settings**, tap **User ID** to
  copy it, and send it to whoever invited you. Until then a recording is refused for lack of minutes.
- The app asks for the microphone when you first record, and for notifications right after, so it can
  tell you when a note is ready.

### What to test

Each build's **What to Test** in TestFlight starts with its version, build number and commit, then says
what to try and what changed. Beyond that, the flows that matter most:

- recording: short and long, with the screen locked, with a call coming in, and stopping then leaving
  the app straight away;
- the note: summary, action items, transcript, and chapters on a long recording;
- search across your notes, and chat with one note;
- deleting a note, and deleting your account (Settings);
- capturing another app's call: **Capture another app** when you start a recording, or in Control
  Center long-press Screen Recording and choose AlgoMinutes. The app asks you to confirm everyone
  agreed before the capture becomes a note.

This is a test environment and it can be reset. **Record only people who agreed, and nothing
confidential.**

### Send feedback

- **Something looks wrong:** take a screenshot in the app, tap it, and choose **Share Beta Feedback**.
  Say what you did and what you expected. TestFlight attaches the build and device.
- **Anything else:** TestFlight → AlgoMinutes → **Send Beta Feedback**.
- **After a crash**, TestFlight offers to send a report: a line about what you were doing helps most.

## Running the beta

### Add a tester

1. **App Store Connect → Users and Access:** invite them (internal testers must be team members; up to
   100). Then **TestFlight → Internal Testing →** your group → add them.
2. When they send their User ID, grant minutes (`resume-staging-and-deploy.md` §4):

   ```bash
   gcloud run jobs execute db-job --region australia-southeast1 --project algominutes-staging \
     --account=algorythmos.france@gmail.com --wait \
     --update-env-vars JOB_NAME=grant-tester,GRANT_UID=<their User ID>
   ```

   Pro minutes for 90 days. Tester ids and emails never go into git.

### Every build

Before it goes to testers:

- [ ] `integration` is green on the commit: `ios-test` (unit tests and the XCUITest smoke) and the
      Staging build.
- [ ] If there's something specific to try, `apps/ios/release-notes/what-to-test.txt` was updated in a
      PR before the build.
- [ ] The Xcode Cloud run is green. Its post-clone log shows the build number and
      `Firebase project: algominutes-staging`. Its post-xcodebuild log shows
      `What to Test: … characters` and `dSYMs uploaded to Crashlytics`.
- [ ] TestFlight shows the build **Ready to Test**, and its What to Test names the right commit.
- [ ] On your own iPhone: a guest launch, a one-minute recording that becomes a note, and the "ready"
      notification.
- [ ] If the privacy manifest or an SDK changed: Xcode Organizer → the archive → **Generate Privacy
      Report**, compared with `PrivacyInfo.xcprivacy` and the App Privacy answers.
- [ ] No `TODO(legal)` or placeholder text is visible in the app.

### Triage feedback

Read **App Store Connect → TestFlight → Feedback** (and Crashlytics) at least every 48 hours. Each item
becomes a GitHub issue labelled `beta` with a severity:

- **P0:** data loss, a leak across accounts, recording without consent, a crash on launch, a wrong charge;
- **P1:** a core flow broken (sign in, record, upload, note, search, chat, delete);
- **P2/P3:** everything else, listed as known issues below until fixed.

Every P0/P1 fix ships with a regression test.

### Pull a bad build

- **App Store Connect → TestFlight →** the build → **Expire Build.** Testers can no longer install or
  launch it. Ship the fix as a new build (a higher build number) and tell the group.
- The api's "please update" gate (426) compares the **marketing version**, so it can't single out one
  build of the same version: expire the build instead.
- Server-side switches work without a build. Broadcast capture: re-plan with
  `TF_VAR_broadcast_capture=off`, then apply (`GET /v1/config` turns the feature off in the app).

### Known issues

Kept here, and in What to Test when a tester would trip on one:

- No purchases: the paywall is off in these builds, and minutes come from grants.
- Share links are off until a viewer is hosted. Exporting and sharing a file work.
- iPhone only.
