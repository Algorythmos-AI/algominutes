# Runbook: the App Review package

> Plan rev 12, Stage 5 (`docs/plans/RELEASE.md`): what goes into App Store Connect for the first submission, and
> the notes the reviewer reads. Everything below is checked against the app's code at the time of writing; recheck
> the marked items against the candidate build before submitting. **Submission itself is the owner's**, from App
> Store Connect (AlgoMinutes, app 6816333591).

## 1. Before you open App Store Connect

All of these must be true, with evidence in `docs/BLOCKERS.md` §0:

- [ ] Production exists and serves the candidate's commit (Apply P, the promotion to `main`, the production deploy
      green with its smoke).
- [ ] The candidate is a **Release** build from the Xcode Cloud "Release → App Store" workflow, with production's
      Firebase plist (`ci_post_clone.sh` refuses any other) and production's api and billing origins.
- [ ] The archive's entitlements show `aps-environment = production`, and `otool -L` lists no
      `GoogleAppMeasurement` or ads framework (`tests/ios-linked-sdks.test.ts` pins the linked products).
- [ ] Xcode's **Privacy Report** for the archive lists exactly the types in `docs/STORE-COMPLIANCE.md` §2.
- [ ] Production's `broadcast_capture` is decided (§4): on only if the device proof of call capture passed.
- [ ] The subscription group (monthly and annual) is "Ready to Submit" and attached to this version.
- [ ] 7 days crash-free in external TestFlight (≥ 99.5% users, no cluster over 0.1% of sessions).
- [ ] Legal sign-off on the Terms, the Privacy Policy and the recording consent (or a dated decision to launch on
      the drafts, recorded in `docs/DECISIONS.md`).

## 2. App information

| Field | Value | Source |
|---|---|---|
| Name | AlgoMinutes | ASC |
| Bundle ID | `com.algorythmos.algominutes` | `apps/ios/project.yml` |
| Category | Productivity (primary), Business (secondary) | owner |
| Age rating | Answer Apple's questionnaire, including the new social-media questions: no user-to-user messaging, no public profiles, no user-generated content shared with others in 1.0 (share links are off). Recommended result: 13+. | owner, plan decision |
| Privacy Policy URL | `https://algominutes.algorythmos.com/privacy` | `apps/site` |
| Support URL | `https://algominutes.algorythmos.com/support` | `apps/site` |
| App Privacy | Enter `docs/STORE-COMPLIANCE.md` §2 exactly: twelve types, all linked, none used to track. | `PrivacyInfo.xcprivacy` |
| Storefronts | All, except mainland China (CallKit, plan decision 5) | owner |
| Release | Phased release for automatic updates, manual release after approval | plan |

## 3. Review notes (paste into "Notes" under App Review Information)

Keep it short and literal; the reviewer follows it step by step. Update the bracketed parts for the candidate.

```
AlgoMinutes records meetings on iPhone and turns them into a transcript and a summary.

No account is needed to try it. On first launch the app creates a private guest account
for this device, with 120 free recording minutes a month, so you can record and read a
summary straight away. Signing in with Apple or Google later keeps the same notes.

To review:
1. Open the app and tap the record button on Home ("Record and generate a smart summary").
2. The first time, a "Before you record" sheet explains what happens to the audio
   (uploaded, transcribed and summarised by Google Cloud's speech and AI services, kept
   until deleted) and asks you to confirm you have permission from anyone being recorded.
   Then iOS asks for the microphone.
3. Speak for a minute, then tap End recording. The note is transcribed and summarised in a
   few minutes; a notification says when it is ready (permission is asked after the first
   recording, not at launch).
4. Open the note to read the summary, action items and transcript. "Ask AI" (Files)
   answers questions about your notes. Transcripts, summaries and answers are produced by
   Google Cloud's speech and AI services, as the "Before you record" sheet says.
5. Scan text (Home) reads text from a photo or document on the device; only the text is
   saved.

Recording while the screen is locked: the app uses the audio background mode only while a
recording the user started is in progress. It never records on its own.

[Only if broadcast_capture is on:] Record a call (Zoom, Teams, Meet): Home > Record a call
shows four steps. It uses a Broadcast Upload Extension that captures the device's audio
only (no video), started by the user from the iOS broadcast picker, and stopped from the
red indicator. The recording becomes a note when you return to the app.

In-app purchase: Settings > Go Pro shows AlgoMinutes Pro (monthly and annual, auto-
renewing). Restore Purchases and Redeem an offer code are in Settings. A subscription is
managed in the App Store (Settings > Manage Subscription).

Account deletion: Settings > Delete my account, type DELETE. For an account signed in with
Apple, the app first revokes its Apple token (you may be asked to sign in with Apple once
more), then deletes every note, recording and summary from our servers.

Support: Settings > Help & Support > Contact support, or support@algorythmos.com.
```

**Sign-in information:** not required (guest start). If App Review asks for an account anyway, create a dedicated
reviewer account on production first (Sign in with Google on a test Google account the owner controls), record a
1-minute note with it so the reviewer sees a finished example, and give those credentials. Never give a real
user's account, and never an invite code: invite codes don't exist in the App Store build.

**Contact information:** the owner's name and a monitored phone number and e-mail (support@ or the owner's).

## 4. Things the reviewer may question, and the answers

| Question | Answer, with where it's true |
|---|---|
| Why the audio background mode? | Only to keep a user-started recording going while the screen is locked (`UIBackgroundModes: audio`, `RecorderService`). Recording never starts on its own (the microphone usage string says so). |
| Why a Broadcast Upload Extension, and why does it ask again each time? | To capture a call's audio in another app; iOS requires the user to start every broadcast from the picker. Audio only, no screen content is kept (`BroadcastExtension/SampleHandler.swift`). Ship it only if the device proof passed; otherwise `broadcast_capture = "off"` hides the entry, and it is never switched on after review. |
| Is recording consent handled? | The "Before you record" sheet asks for confirmation every first recording and explains processing (`RecorderFlow.swift`). Legal's opinion on recording consent is a Stage 5 sign-off item. |
| Does it use AI? | Yes: transcription and summaries by Google Cloud (Speech-to-Text, Gemini on Vertex AI in Sydney); the consent sheet and Privacy Policy say so, and the chat is labelled "Ask AI". Transcripts are scrubbed of payment card and similar numbers before any model sees them (CLAUDE.md, `redaction.cjs`). **Open (owner):** the summary itself carries no "written by AI" label; consider one before submission. |
| CallKit? | Only `CXCallObserver`, so a recording waits while a phone call holds the microphone (`RecorderService`); no VoIP calling. The app isn't offered in mainland China. |
| Free trial? | Not in 1.0: every account gets a free monthly floor instead (120 minutes). The app promises a trial only to someone in one (#472). |
| Account deletion (5.1.1(v)) | In-app, with Apple token revocation; a failed revocation asks Try again or Delete anyway (#451). |

## 5. After submitting

- Watch App Store Connect for the review status and any message from App Review; reply in Resolution Center the
  same working day.
- If rejected: record the guideline and Apple's words in `docs/BLOCKERS.md` §0, fix test-first, and resubmit with
  a short note on what changed.
- On approval: the phased release starts; a P0 pauses it (`docs/runbooks/production-incident.md`).
