# External TestFlight: the beta (RELEASE.md PR 16)

The external beta runs on **staging** (`algominutes-staging`, which keeps data like production:
DECISIONS 2026-09-29). Testers are invited by email to the external group **AlgoMinutes beta**, and get
their minutes from an **invite code**. External builds go through **Beta App Review**; internal testing
(`testflight-internal.md`) carries on alongside. The first part is for testers; the rest is for whoever
runs the beta.

## For testers

### Install

1. Open the TestFlight invite email on your iPhone, and tap **View in TestFlight** (install **TestFlight**
   from the App Store first if it asks).
2. Install AlgoMinutes from TestFlight. You need an iPhone on iOS 17 or later.

### First launch

- You start as a **guest**, with no sign-up. To keep your notes with Apple or Google, use **Settings →
  Create account**; your notes move with you. Signing out as a guest deletes them, and the app says so
  first.
- **Enter your invite code:** **Settings → Enter an invite code**, then the code from your invitation
  (`BETA-…`). It adds your recording minutes. If you record before entering it, the app asks for it.
- The app explains the microphone before iOS asks, and notifications after your first recording
  starts. If you refused the microphone, the app offers **Open Settings**.
- Files shows an **example note** until your first real one, so you can see what a recording becomes.

### What to test

Each build's **What to Test** says what to try first. The flows that matter most:

- recording: short and long, with the screen locked, with a call coming in, and stopping then leaving the
  app straight away;
- the note: summary, action items, transcript, and chapters on a long recording;
- search across your notes, and chat with one note;
- deleting a note, and deleting your account (Settings);
- capturing a call in another app (FaceTime, Zoom, Teams): **Capture another app** when you start a
  recording, or in Control Center long-press Screen Recording and choose AlgoMinutes. The app asks you to
  confirm everyone agreed before the capture becomes a note.

Your notes are kept for the whole beta, and backed up. The public release starts fresh: you'll be told
before then, with time to export your notes. **Record only people who agreed, and nothing
confidential.**

### Send feedback

- **Something looks wrong:** take a screenshot in the app, tap it, and choose **Share Beta Feedback**.
  Say what you did and what you expected.
- **Anything else:** TestFlight → AlgoMinutes → **Send Beta Feedback**, or **Settings → Help & Support**
  in the app.

## Running the external beta

### Once: the Staging → Beta workflow

The internal workflow's builds are **TestFlight (Internal Testing Only)** and can never go external. The
external beta needs its own workflow (App Store Connect → Xcode Cloud → Manage Workflows → +):

- **Name:** `Staging → Beta`.
- **Start condition:** manual only. You choose which build goes to testers.
- **Environment:** Xcode 26.3, with the same secret `GOOGLE_SERVICE_INFO_PLIST_B64` as `Staging → Internal`
  (`xcode-cloud.md`).
- **Action:** Archive, iOS, scheme **`AlgoMinutes-Staging`**, distribution **TestFlight and App Store**.
- **Post-action:** TestFlight Internal Testing → your internal group only. A build is added to the
  external group by hand, after the every-build checklist below.

### Once: the external group and Test Information

1. **TestFlight → External Testing → +:** a group named **AlgoMinutes beta**.
2. **TestFlight → Test Information** (English):
   - **Beta App Description:**

     > AlgoMinutes records a meeting on your iPhone and turns it into notes: a summary, action items,
     > decisions, chapters and a searchable transcript. You can also capture your side and the other side
     > of a call in another app. This beta runs on our test service: your notes are kept for the beta and
     > backed up, and the public release starts fresh, with notice and time to export. Record only people
     > who agreed, and nothing confidential.

   - **Feedback Email:** `support@algorythmos.com`.
   - **Marketing URL:** `https://algominutes.algorythmos.com`.
   - **Privacy Policy URL:** `https://algominutes.algorythmos.com/privacy`.
3. **Beta App Review Information:**
   - **Contact:** your name, phone and email.
   - **Sign-in required:** off. The app starts as a guest.
   - **Review Notes:** the text below, with the reviewer's invite code filled in.

     > The app starts as a guest; no account is needed. To record, open Settings → Enter an invite code and
     > enter BETA-XXXXX-XXXXX-XXXXX (it adds minutes; testers get their own codes).
     >
     > Recording: the app asks the user to confirm they have permission from everyone recorded before the
     > first recording, and records only while the red recording screen is showing. Audio is uploaded to
     > our service to be transcribed and summarised.
     >
     > Capturing another app's call uses a Broadcast Upload Extension, started only by the user (Capture
     > another app, or Control Center → Screen Recording → AlgoMinutes). It captures audio only, never
     > video, and it becomes a note only after the user confirms again that everyone on the call agreed.
     > It can be switched off from our server without a new build.
     >
     > This beta uses our test backend (algominutes-staging). Notes are kept for the beta; the public
     > release starts fresh.

4. Make the reviewer's code (5 uses, 30 days), below, and put it in the Review Notes.

### Invite codes

Each cohort gets its own code, so one can be revoked without the others. On your Mac:

```bash
scripts/new-invite-code.sh
```

It prints the code (for the testers only: it's stored nowhere) and the command that registers its hash on
staging. Set the label and limits in that command before running it:

- **Reviewer:** `INVITE_LABEL=beta review,INVITE_USES=5,INVITE_DAYS=30`.
- **A cohort:** `INVITE_LABEL=cohort 1,INVITE_USES=25,INVITE_DAYS=30`. The default is 600 minutes each
  (`INVITE_MINUTES`).
- From Wave 2, add `INVITE_NOTETAKER=true` to let the cohort send the notetaker.

`JOB_NAME=beta-invite,MODE=list` lists codes with their uses; `MODE=revoke,INVITE_ID=<id>` stops one. Codes
never go into git, a ticket or a chat message: send each one in the invitation email.

### Add a cohort

1. Make the cohort's code.
2. **TestFlight → External Testing → AlgoMinutes beta → Testers → +:** add their emails. External testers
   don't need to be on the team. Sizes: Wave 1 up to 25, Wave 2 up to 50, Wave 3 up to 100.
3. Email them the code and a link to this page's "For testers", or paste that section into the email.
4. Widen the beta only after 7 days with no open P0 or P1, crash-free sessions at or above 99.5%
   (Crashlytics), spend under the daily cap, and the nightly e2e green.

### Every build

The internal checklist (`testflight-internal.md`, "Every build") first. Then, for external testers:

- [ ] The build came from `Staging → Beta`, not `Staging → Internal`.
- [ ] `apps/ios/release-notes/what-to-test.txt` reads right for someone outside the team.
- [ ] **External Testing → AlgoMinutes beta → Builds → +:** the build. The first build of each version goes
      to Beta App Review (usually under a day); later builds of the same version usually don't.
- [ ] If review asks about recording or broadcast, the Review Notes above answer it. If broadcast is
      rejected, switch it off (`TF_VAR_broadcast_capture=off`, applied) and submit a new build. It must
      not be switched back on for a version reviewed without it (Guideline 2.3.1).

### Pull a bad build, triage feedback

As for internal builds (`testflight-internal.md`): **Expire Build** in TestFlight, and a new build with a
higher number. Triage external feedback the same way, every 48 hours, into GitHub issues labelled `beta`.
