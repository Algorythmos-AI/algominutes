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

The paste-ready text lives in one place: `docs/plans/APP-STORE-REVIEW-PACKAGE.md` §1.1, in two variants
(call capture in 1.0, or removed), with its character count, and §1.2–1.4 for What's New, the promotional text
and the subscriptions' names and descriptions. Paste the variant that matches the build: the extension embedded
and `broadcast_capture` "on", or both gone.

**Sign-in information:** not required (guest start). If App Review asks for an account anyway, create a dedicated
reviewer account on production first (Sign in with Google on a test Google account the owner controls), record a
1-minute note with it so the reviewer sees a finished example, and give those credentials. Never give a real
user's account, and never an invite code: invite codes don't exist in the App Store build.

**Contact information:** the owner's name and a monitored phone number and e-mail, typed into App Store Connect
only, never into the repo.

## 4. Things the reviewer may question, and the answers

| Question | Answer, with where it's true |
|---|---|
| Why the audio background mode? | Only to keep a user-started recording going while the screen is locked (`UIBackgroundModes: audio`, `RecorderService`). Recording never starts on its own (the microphone usage string says so). |
| Why a Broadcast Upload Extension, and why does it ask again each time? | To capture a call's audio in another app; iOS requires the user to start every broadcast from the picker. iOS labels it "Screen Recording", but only audio is kept: video buffers are ignored (`BroadcastExtension/SampleHandler.swift`). A capture started from Control Center asks "Turn your capture into a note?" before anything is uploaded (`RootView.swift`). Ship it only if the device proof passed; otherwise `broadcast_capture = "off"` hides the entry, and it is never switched on after review. |
| Is recording consent handled? | The "Before you record" sheet asks for the permission tick every time it opens and explains processing (`RecorderFlow.swift`). Before it, once per device, the app asks to send recordings to Google Cloud AI (5.1.2(i), `AISharingConsent.swift`); "Not now" sends nothing. Legal's opinion on recording consent is a Stage 5 sign-off item. |
| Does it use AI? | Yes: transcription and summaries by Google Cloud (Speech-to-Text, Gemini on Vertex AI in Sydney); the consent sheet and Privacy Policy say so, and the chat is labelled "Ask AI". Transcripts are scrubbed of payment card and similar numbers before any model sees them (CLAUDE.md, `redaction.cjs`). The summary and Ask AI are labelled "Written by Algorythmos AI" / "Algorythmos AI answers can be wrong", and so are exports, with a machine-readable mark in PDF and DOCX metadata (#535). |
| CallKit? | Only `CXCallObserver`, so a recording waits while a phone call holds the microphone (`RecorderService`); no VoIP calling. The app isn't offered in mainland China. |
| Free trial? | Yes, with no payment: the first recording on a new iPhone starts a 7-day reverse trial with Pro's minutes (`trial_on_first_use = "on"` in production since 2026-10-27; `TRIAL_DAYS`, `packages/contracts/src/limits.ts`). Apple DeviceCheck marks the device, so a reinstall doesn't start another (#503). After it, the free floor of 120 minutes a month. Pro is sold only with StoreKit (A$14.99 a month, A$149.99 a year). The app shows "N days left in your trial" only to someone in one (#472). |
| Account deletion (5.1.1(v)) | In-app, with Apple token revocation; a failed revocation asks Try again or Delete anyway (#451). |

## 5. After submitting

- Watch App Store Connect for the review status and any message from App Review; reply in Resolution Center the
  same working day.
- If rejected: record the guideline and Apple's words in `docs/BLOCKERS.md` §0, fix test-first, and resubmit with
  a short note on what changed.
- On approval: the phased release starts; a P0 pauses it (`docs/runbooks/production-incident.md`).
