# The App Review package for 1.0

**Draft for the owner, updated 2026-10-29.** Checked against `origin/main` at 24adcde7 (promotion #541, which
carries #532, #535, #537 and #539; `integration` at 433cfe47 has the same tree). Production runs it: the
`deploy-production` run for 24adcde7 is green (migrate, api rollout and smoke). The iOS half of #535 and #537
reaches App Review only in the next Release build (RC1). Nothing was changed in App Store Connect. It builds on
`docs/runbooks/app-store-review.md`, which now points here for the notes. It is the review half of R12.5 Stage 5.

Status words: **pass** = the repo shows it. **not verified** = needs a device, a console or a person.
**fail** = the repo shows it is not done.

## Owner decisions

- **"Record a call" in 1.0** (RELEASE.md status decision 3, R12.5 Stage 5). **Pending proof 5, due 11-05.** The
  binary on `main` embeds the Broadcast Upload Extension and production's `broadcast_capture` is "on", so §1.1
  variant A matches the build as it is. Default: **off unless proof 5 passes, and "off" means the extension is
  removed from the 1.0 binary**, not just switched off (§6); then paste variant B.
- **Demo account.** Default: **none**; the app starts as a guest with free minutes (§2).
- **App name.** `AlgoMinutes: AI Meeting Notes` (STORE-LISTING §1.3) or `AlgoMinutes` (the runbook's table).
  Default: **the longer name**, which carries search weight.
- **Keyword "lecture" vs "summarize"** (§4.1). Default: "summarize".
- Decided and shipped: the one-time Google Cloud AI agreement (5.1.2(i), #537) and the "Written by Algorythmos AI"
  label (#535).

## 1. Paste-ready for App Store Connect

Australian spelling, as in the app. Character counts are of the text between the fences, line breaks counted
as one character each (App Store Connect's limit for Notes is 4,000).

### 1.1 App Review Information › Notes

**Blocking: the FREE MINUTES paragraph is not yet true in the app** (Drift, first item). Don't submit with it
until the free-floor gate in `Entitlement.swift` is fixed, or the reviewer meets the paywall on the second
recording.

**Variant A: call capture stays in 1.0** (proof 5 passed; the extension embedded, production `broadcast_capture`
"on"). This is the binary on `main` today. **3,885 characters.**

```
AlgoMinutes records a meeting on iPhone and turns it into a transcript and a summary.

NO ACCOUNT NEEDED
Sign-in is not required. On first launch the app makes a private guest account for this device. Settings > Create account (Sign in with Apple or Google) keeps the same notes.

FREE MINUTES
A new iPhone gets a 7-day trial with Pro's recording minutes: no payment, not a subscription, once per device (Apple DeviceCheck). After it, or on a device that has had the trial, every account has 120 free recording minutes a month.

TO REVIEW
1. On Home, tap "Instant Recorder".
2. Once per device the app asks "Send your recordings to Google Cloud AI?" (audio and its text go to Google Cloud's speech and AI services, Gemini, to be transcribed and summarised; Google doesn't train on it). Tap "Agree and continue". "Not now" sends nothing and leaves you on Home; it is asked again before anything is sent. Settings > Google Cloud AI turns it off or on.
3. "Before you record" says what is recorded and where it goes. Tick "I have permission from anyone whose voice may be captured" (asked every time) and tap "Start recording". iOS asks for the microphone, then the app explains and asks for notifications.
4. Speak for a minute and tap End. The note is usually ready within a few minutes.
5. Open the note (Home or Files) for the summary, action items, key decisions and transcript. "Weekly product sync (example)" is a built-in sample, not AI-written.
6. Ask AI: in a note, "Ask about this meeting"; Files > Ask AI asks across all notes.
7. Export: tap a ready note's share icon, choose Summary, Transcript or both, then Export to PDF, TXT or DOCX, or Export files to Email.
Import Files and Scan Text on Home also make notes.

AI-GENERATED CONTENT
Transcripts, summaries and answers come from Google Cloud (Speech-to-Text, and Gemini on Vertex AI). A note's summary is labelled "Written by Algorythmos AI from your recording. Check anything important." Ask AI shows "Algorythmos AI answers can be wrong." PDF, TXT and DOCX exports and the e-mail body open with a "written by Algorythmos AI" notice, and PDF and DOCX carry a machine-readable "AI-generated" mark in their metadata. Card and similar numbers are masked before text reaches Gemini. Nothing is shared with other users or used for ads or tracking.

BACKGROUND AUDIO
Used only to keep a recording the user started going while the screen is locked. The app never records on its own.

CALL CAPTURE
In "Before you record", tick the box and tap "Record a call (Zoom, Teams, Meet)", or start it from Control Center (long-press Screen Recording, choose AlgoMinutes, Microphone on, Start Broadcast). iOS calls this "Screen Recording", but the Broadcast Upload Extension keeps audio only and drops every video frame. Stop it from the red indicator; back in the app the capture becomes a note. A capture started from Control Center skipped the tick, so the app asks first: "Turn your capture into a note?" (I have permission / Discard the capture / Not now, which keeps it on the iPhone), after the Google Cloud AI agreement if not yet given.

SUBSCRIPTIONS
Settings > Go Pro opens AlgoMinutes Pro: Pro Monthly and Pro Annual, auto-renewing, priced by the App Store, with renewal terms, Terms of Service and Privacy Policy. Buy with your sandbox account. Restore Purchases is on that screen and in Settings, and works for a guest. Settings > Redeem an offer code. After a purchase, Settings > Manage Subscription.

ACCOUNT DELETION
Settings > Delete my account, type DELETE, tap Delete forever. For an account signed in with Apple, the app first revokes its Apple token (you may be asked to sign in with Apple again). Every note, recording and summary is then deleted from our servers. A guest account is deleted the same way.

CONTACT
Settings > Help & Support > Contact support, or the contact details in this App Review Information.
```

**Variant B: call capture removed from 1.0** (proof 5 failed or not run by 11-05). Paste it only after §6's
changes are in the build: the `BroadcastExtension` dependency out of the `AlgoMinutes` Release target
(`apps/ios/project.yml`, `embed: true` today), the call clause out of `NSMicrophoneUsageDescription`, and
production `broadcast_capture` "off" (reviewed plan and apply, then redeploy). **3,344 characters.**

```
AlgoMinutes records a meeting on iPhone and turns it into a transcript and a summary.

NO ACCOUNT NEEDED
Sign-in is not required. On first launch the app makes a private guest account for this device. Settings > Create account (Sign in with Apple or Google) keeps the same notes.

FREE MINUTES
A new iPhone gets a 7-day trial with Pro's recording minutes: no payment, not a subscription, once per device (Apple DeviceCheck). After it, or on a device that has had the trial, every account has 120 free recording minutes a month.

TO REVIEW
1. On Home, tap "Instant Recorder".
2. Once per device the app asks "Send your recordings to Google Cloud AI?" (audio and its text go to Google Cloud's speech and AI services, Gemini, to be transcribed and summarised; Google doesn't train on it). Tap "Agree and continue". "Not now" sends nothing and leaves you on Home; it is asked again before anything is sent. Settings > Google Cloud AI turns it off or on.
3. "Before you record" says what is recorded and where it goes. Tick "I have permission from anyone whose voice may be captured" (asked every time) and tap "Start recording". iOS asks for the microphone, then the app explains and asks for notifications.
4. Speak for a minute and tap End. The note is usually ready within a few minutes.
5. Open the note (Home or Files) for the summary, action items, key decisions and transcript. "Weekly product sync (example)" is a built-in sample, not AI-written.
6. Ask AI: in a note, "Ask about this meeting"; Files > Ask AI asks across all notes.
7. Export: tap a ready note's share icon, choose Summary, Transcript or both, then Export to PDF, TXT or DOCX, or Export files to Email.
Import Files and Scan Text on Home also make notes.

AI-GENERATED CONTENT
Transcripts, summaries and answers come from Google Cloud (Speech-to-Text, and Gemini on Vertex AI). A note's summary is labelled "Written by Algorythmos AI from your recording. Check anything important." Ask AI shows "Algorythmos AI answers can be wrong." PDF, TXT and DOCX exports and the e-mail body open with a "written by Algorythmos AI" notice, and PDF and DOCX carry a machine-readable "AI-generated" mark in their metadata. Card and similar numbers are masked before text reaches Gemini. Nothing is shared with other users or used for ads or tracking.

BACKGROUND AUDIO
Used only to keep a recording the user started going while the screen is locked. The app never records on its own.

CALL CAPTURE
This version has no call capture and no broadcast extension. Recording uses the microphone only.

SUBSCRIPTIONS
Settings > Go Pro opens AlgoMinutes Pro: Pro Monthly and Pro Annual, auto-renewing, priced by the App Store, with renewal terms, Terms of Service and Privacy Policy. Buy with your sandbox account. Restore Purchases is on that screen and in Settings, and works for a guest. Settings > Redeem an offer code. After a purchase, Settings > Manage Subscription.

ACCOUNT DELETION
Settings > Delete my account, type DELETE, tap Delete forever. For an account signed in with Apple, the app first revokes its Apple token (you may be asked to sign in with Apple again). Every note, recording and summary is then deleted from our servers. A guest account is deleted the same way.

CONTACT
Settings > Help & Support > Contact support, or the contact details in this App Review Information.
```

Both variants differ only in the CALL CAPTURE paragraph.

### 1.2 What's New in This Version

**None needed for 1.0.** App Store Connect asks for What's New only from the second version; the first
version has no field for it (not checked in App Store Connect today). TestFlight's What to Test is separate and
is written by `ci_post_xcodebuild.sh`.

### 1.3 Promotional Text (≤170)

```
Record a meeting and get back a summary, the decisions and the action items, written for you. Ask your notes a question. No ads, no tracking.
```

141 characters. It leaves out minutes and the trial on purpose: promotional text changes without review, and
the free-minutes claim waits on the Drift fix. STORE-LISTING §5.1's "New: meeting templates…" reads wrong on a
1.0.

### 1.4 Subscriptions

Subscription group **AlgoMinutes Pro** (its display name is the paywall's title). The names and descriptions
are the ones the paywall shows (`product.displayName` under "AlgoMinutes Pro", above "Billed every month,
auto-renews"; headline "1,500 minutes a month, and every note searchable and summarised") and match the local
StoreKit file `apps/ios/StoreKit/AlgoMinutes.storekit`. Limits as App Store Connect states them (display name
30, description 45); not checked in App Store Connect today.

| Product ID | Display name | Description |
|---|---|---|
| `com.algorythmos.algominutes.pro.monthly` | `Pro Monthly` (11) | `1,500 minutes a month` (21) |
| `com.algorythmos.algominutes.pro.annual` | `Pro Annual` (10) | `1,500 minutes a month, billed yearly` (36) |

1,500 is `PLAN_MONTHLY_INCLUDED_MINUTES.pro` (`packages/contracts/src/limits.ts`); both products are plan `pro`
(`services/billing/src/lib/plans.js`), so the annual plan also gives 1,500 a calendar month. Each product also
needs a review screenshot of the paywall, status Ready to Submit, attached to version 1.0.

### 1.5 Fields next to the Notes

- **Sign-in required:** unticked (guest start).
- **Contact information:** a name, a monitored phone and e-mail, typed into App Store Connect only, never into
  the repo.
- **Attachment (optional):** a 30–60 s screen recording of steps 1–5 on a Release build against production,
  with fictional content (§3).

### 1.6 What the notes rely on

| Claim | Where | Status |
|---|---|---|
| Guest start on first launch | `Features/Root/RootView.swift` (`ensureAnonymousIdentity`), `AuthService.swift`; Settings › Create account for a guest | pass in code; fresh-guest lane green on the lab iPhone (Debug, staging); not verified on a Release build against production |
| 7-day trial, once per device, no payment | prod `trial_on_first_use = "on"` (`infra/terraform/envs/prod/main.tf`), `TRIAL_DAYS = 7`; #503, #526 | pass |
| 120 free minutes a month after the trial | prod `free_floor_minutes = 120`; `packages/db/src/entitlements.ts` | server pass; **fail in the app**: `Entitlement.gatesMeteredActions` sends every free-floor tap on Instant Recorder or Import Files to the paywall, whatever is left (Drift) |
| The Google Cloud AI agreement before "Before you record", "Not now", Settings › Google Cloud AI | `Features/Home/HomeView.swift` (`aiSharing.gate` before the sheet), `Services/AISharingConsent.swift` (`AISharingCopy`), `Features/Privacy/AISharingConsentSheet.swift` | pass in code (#537, on `main`); in a Release build from RC1 |
| "Instant Recorder" | `Features/Home/HomeView.swift` | pass |
| Sheet text, tick every time, "Start recording" | `Features/Recorder/RecorderFlow.swift` | pass |
| Notifications asked once a recording has started, with an explanation first | `App/AppEnvironment.swift` (after the microphone prompt), `RecordingNotifier` | pass |
| "End" | `Features/Recorder/RecordingView.swift` | pass |
| "Usually ready within a few minutes" | S17: 19 minutes for a 23 s note on prod | **not verified, a risk**: don't submit until S17 is mitigated (`APP-STORE-GEMINI-CAPACITY.md`) |
| The example note, unlabelled | `Features/Files/SampleNoteView.swift` (`aiNotice: nil`), `Models/SampleNote.swift` (#539) | pass |
| Ask AI in a note and in Files | `Features/NoteDetail/AskAIComposer.swift`, `Features/Files/FilesView.swift`, `Features/Chat/ChatView.swift` | pass in code; chat hit a 429 on staging on 10-28 (S2/S17) |
| AI labels | in-app: the summary (`SummaryPane`, `NoteExport.inAppNotice`) and Ask AI (`askAINotice`); exports: `NoteExport.aiNotices` at the top of PDF and TXT, `export-note.cjs` for DOCX; e-mail body `NoteExport.emailBody`; mark in PDF Creator/Keywords and DOCX creator/description/keywords (#535). The in-app Transcript tab has no label; the share page has one but share links are off in production | pass in code; DOCX server side is deployed; the iOS side in RC1 |
| Export menu | `Features/NoteDetail/ShareExportSheet.swift`: Summary / Transcript / Summary & transcript; Export to PDF, TXT, DOCX; Export files to Email | pass |
| Masking before Gemini | `@algominutes/ai/redaction.cjs` | pass in code |
| Go Pro, Restore (paywall and Settings), Redeem, Manage Subscription | `Features/Settings/SettingsView.swift`, `Features/Paywall/PaywallView.swift`; Release `PAYWALL_ENABLED "YES"`, `INVITE_CODES_ENABLED "NO"` | pass |
| Delete my account, DELETE, Delete forever, Apple revocation | `SettingsView.swift`; #451 | pass in code; **not verified on prod** (A8) |
| Call capture: two ways in, "Turn your capture into a note?", audio only | `RecorderFlow.swift` (`callTitle`), `RootView.swift` (the confirmation dialog), `AppEnvironment.claimBroadcastCapture`, `BroadcastHandoff.decide` (agreement, then permission), `BroadcastExtension/SampleHandler.swift` (video buffers ignored) | pass in code; proof 5 open |
| Contact support | `Features/Settings/HelpSupportView.swift` | pass |

## 2. Demo account

**Not needed.** Guest start, 120 free minutes for every new account (A7 closed by `free_floor_minutes = 120`),
and App Review buys with its own sandbox Apple Account. (The app-side free-floor gate in Drift must be fixed
first, or a reviewer on a device that has had the trial meets the paywall from the second recording.)

**Only if App Review asks:** the owner makes a dedicated reviewer account on **production** with Sign in with
Google on an account used for nothing else (never a real user's, never an invite code); records one 1-minute
fictional note; puts the credentials **only** in App Store Connect's Sign-in information and the owner's
password manager. BLOCKERS records only that a reviewer account exists and when, never an address, password or
uid. After approval: delete it in the app (which also proves 5.1.1(v) on prod) and change the Google
password.

## 3. Screenshots

**Sizes.** 6.9": 1320 × 2868 (Pro Max simulator). 6.5": 1284 × 2778, optional (App Store Connect scales the
6.9" set). Portrait, plan for 6, iPhone only.

**How, with no real content.** A Release build (after #525's promotion) against production; a dedicated
screenshot account, deleted afterwards; fictional, scripted meetings voiced by macOS text-to-speech and brought
in with Import Files (fictional first names only); status bar via `xcrun simctl status_bar booted override
--time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`; light mode, default text
size. Never show prices, the trial countdown, "Record a call", the notetaker, a share link, any address, uid or
device name, or Settings' account rows.

| # | Screen | State | Caption |
|---|---|---|---|
| 1 | Note, Summary | "Q3 launch planning": gist, 3 decisions, 4 action items | Every meeting, summed up: decisions and action items, done for you. |
| 2 | Note, Action items | 2 of 4 ticked | Turn talk into a to-do list. |
| 3 | Note, Transcript | in-note search, one word highlighted | A full transcript you can search. |
| 4 | Template picker | over "Candidate interview", "Interview" selected | Summaries tuned to your kind of meeting. |
| 5 | "Before you record" | first-run text, box ticked | Consent built in, before every recording. |
| 6 | Ask AI | a question about the fictional notes and its answer | Ask your meetings a question. No ads, no tracking. |

Optional 7th: Home with the three entry points. "Record, import or scan. Notes in minutes."

Changes from `STORE-LISTING.md` §2: shot 5 was "Everyone's kept in the loop" (the app tells no one; the user
promises to); shot 2 drops "owner + task" (action items have no owner field); shot 3's title "Searchable,
accurate transcript" drops "accurate" and is now "Searchable transcript" in `STORE-LISTING.md` too.

## 4. Listing copy

### 4.1 Fields

| Field | Text | Length |
|---|---|---|
| Name (≤30) | `AlgoMinutes: AI Meeting Notes` | 29 |
| Subtitle (≤30) | `Record, transcribe, summarise` | 29 |
| Keywords (≤100) | `transcription,voice recorder,notetaker,action items,speech to text,minutes,summarize,interview` | 94 |
| Promotional text (≤170) | §1.3 | 141 |
| Category | Productivity, then Business | — |
| Privacy Policy URL | `https://algominutes.algorythmos.com/privacy` | — |
| Support URL | `https://algominutes.algorythmos.com/support` | — |
| EULA | Apple's standard, or `/terms` as a custom one (`APP-STORE-LEGAL.md`); linked in the description either way (3.1.2) | — |

Promotional text can change without review. Keywords counted: 94.

### 4.2 Description

```
AlgoMinutes turns your meetings into a summary, the key decisions and a list of action items.

Tap record, talk, and get back a clean summary, the decisions that were made and the next steps. No more taking notes while you try to stay in the conversation.

WHAT YOU GET
- Summaries in minutes: the gist of a meeting, written for you.
- Action items, pulled out: the next steps, as a list you can tick off.
- Key decisions, captured: the calls that were made, in one place.
- A searchable transcript: find any moment without scrubbing audio.
- Templates: general meeting, standup, interview, sales call, lecture, one-on-one, board meeting, client meeting and action items only.
- Record, import or scan: record with your microphone, import an audio file, or scan text from a document.
- Ask AI: ask a question across your notes.

PRIVATE BY DESIGN
- No ads. No tracking.
- A plain-English notice before every recording, and you confirm you have permission to record.
- Delete any note, or your whole account, from the app at any time.
- Transcripts and summaries are made by AI (Google Cloud). Check them before you rely on them.

START FREE
A new iPhone starts with 7 days of Pro recording minutes, with no payment. After that, every account has 120 free minutes a month.

ALGOMINUTES PRO
AlgoMinutes Pro gives 1,500 recording minutes a month. It is an auto-renewing subscription, monthly or annual. Payment is charged to your Apple Account. It renews unless cancelled at least 24 hours before the end of the period. Manage or cancel it in your App Store account settings.

Terms of Use: https://algominutes.algorythmos.com/terms
Privacy Policy: https://algominutes.algorythmos.com/privacy
```

START FREE depends on the free-floor fix (Drift); until then drop its second sentence. "1,500 recording minutes" is `PLAN_MONTHLY_INCLUDED_MINUTES.pro` and the nine templates are `SummaryTemplateId`
(`packages/contracts`) [code].

### 4.3 Claims in `STORE-LISTING.md` the app can't back

| Claim | Problem | In §4.2 |
|---|---|---|
| "Instant summaries … in seconds" | S17: 19 minutes for 23 s on prod | "Summaries in minutes" (fixed in `STORE-LISTING.md`, with "instant" dropped from the Play copy) |
| "who's doing what" / "owner + task" | Action items are plain strings | "the next steps" |
| "Record … the audio of a call" | Call capture out of 1.0 by default (§6) | Mic, import, scan |
| "New: meeting templates" | Nothing is new in a 1.0 | Rewritten |
| "Everyone's kept in the loop" | The app tells no one | "Consent built in" |
| "Searchable, accurate transcript" | An accuracy claim the Terms disclaim | "Searchable transcript" (fixed in `STORE-LISTING.md`) |
| Play copy: "review on the web", "delete … including from the web" | No shipped web app; web deletion is an e-mail request | Not in the Apple copy; fix before Play |
| Terms and Privacy links missing | 3.1.2 | Added |

## 5. Pre-submission checklist by guideline

| Guideline | Item | Status | Evidence |
|---|---|---|---|
| 2.1 | Record and read a summary with no account and no purchase | **fail after the trial** | guest start; server `free_floor_minutes = 120`, `trial_on_first_use`; but the app gates every free-floor recording behind the paywall (Drift) |
| 2.1 | A note finishes in a few minutes on prod | **not verified (risk)** | S17 P0; #505/#506 merged, reach prod with #525; capacity is the owner's |
| 2.1 | Push arrives when a note is ready | **not verified** | I10; #512 merged, not proven on prod |
| 2.1 | Upload recovery never fails silently | pass in code | I11 → #508 |
| 2.1 | Device pass on the candidate | partly | 10-28/29 on the iPhone 11 (iOS 27.0.1): UI lane green 4 times, unit lane 3 times (432 passed), fresh-guest green, `--release` against production green (8 passed, 0 flaky). Hand-run checks of device passes 1 and 2 (Sign in with Apple, a real call, VoiceOver, push) not recorded; the recording test skipped (staging app on a guest) |
| 2.1 | 7 days crash-free ≥99.5% in external TestFlight; 7 green nights | **not verified** | Phase C not started |
| 2.1 | IAP products Ready to Submit and attached | **not verified** | owner, App Store Connect |
| 2.1 | A sandbox purchase reconciled on prod billing | **not verified** | S18 |
| 2.3 | Listing claims match the app | pass after §4.3 | |
| 2.3.1 | No hidden or dormant features | **not verified** | prod `broadcast_capture` "on" (O10) and the extension embedded while proof 5 is open; §6 and §1.1's two variants. Notetaker: `notetaker_surfaces` defaults to "" in prod; confirm `GET /v1/config` on prod shows it off |
| 3.1.1 | Pro only through StoreKit; no invite codes in the store build; offer codes for free time; Restore reachable | pass | `PaywallView.swift`, `INVITE_CODES_ENABLED "NO"`, `.offerCodeRedemption`, #472, #473 |
| 3.1.3(b) | Web Pro honoured, no link out to buy | pass | `PaywallView.swift` |
| 3.1.2 | Paywall: name, period, price, auto-renew terms, Terms and Privacy links; Manage Subscription | pass | `PaywallView.swift`, `SettingsView.swift` |
| 3.1.2 | Terms of Use linked in the metadata; subscription names, descriptions, review screenshot | **not verified** | §4.2; owner |
| 3.1.2 | The reverse trial is minutes, not an introductory offer | pass | #472 |
| 4.0 | iPhone only, no Catalyst | pass | `TARGETED_DEVICE_FAMILY "1"`, `SUPPORTS_MACCATALYST NO` |
| 4.0 | "iPhone apps on Apple silicon Macs" off | **not verified** | owner |
| 4.0 | Largest text size | pass in tests | #515 |
| 4.8 | Sign in with Apple alongside Google | pass | R12.1 |
| 5.1.1 | Purpose strings say what, why, where | pass | `Info.plist`. **If call capture is removed, the microphone string must drop "or your side of a call in another app that you choose to capture"** (and STORE-COMPLIANCE §4.2) |
| 5.1.1 | Legal sign-off, or a dated decision to launch on drafts | **not verified** | `APP-STORE-LEGAL.md`; the site still says "in beta" (`LegalNotice.astro`) |
| 5.1.1 | Age rating 13+ answered honestly; share links off on prod | **not verified** | owner; `switches.shareLinks` |
| 5.1.1(v) | In-app deletion; server data, Postgres first; Apple token revoked; cancel-subscription note | pass in code | `SettingsView.swift`, `services/api/src/routes/delete-account.js`, #451 |
| 5.1.1(v) | A deletion proven on prod | **not verified** | A8 |
| 5.1.2 | App Privacy answers = the privacy manifest; no tracking SDK | pass | `tests/app-privacy-answers.test.ts`, `tests/ios-linked-sdks.test.ts` |
| 5.1.2 | Privacy Report of the candidate matches | **not verified** | `APP-STORE-XCODE-CLOUD-RELEASE.md` §4 |
| 5.1.2(i) | Data sent to third-party AI disclosed, with explicit permission | pass in code (#537, on `main` 24adcde7); in a build from RC1 | A one-time "Send your recordings to Google Cloud AI?" agreement, separate from the permission tick, before the first upload on every path; withdrawn in Settings › Google Cloud AI (CONSENT §2.2) |
| 5.1.2 | Summaries labelled as AI-written | pass in code | #535 on `main` 24adcde7 (DOCX deployed to production; iOS from RC1); the example note unlabelled (#539); `APP-STORE-AI-LABEL.md` |

## 6. Call capture at review: remove it from the 1.0 binary

**Recommendation:** take the Broadcast Upload Extension out of the 1.0 Release build and set production's
`broadcast_capture` to "off", unless proof 5 passes by 11-05. This is R12.5 Stage 5's "otherwise removed from
1.0", made concrete.

1. **Proof 5 isn't there.** A real broadcast killed mid-call, picked up and processed, has not been run. I3's
   fix (fragmented MP4, **#532**) is merged and on `main`; its evidence is an in-process kill test on the iPhone 11 (unit lane
   437 executed, 0 failures), and it says proof 5 is still manual.
2. **Switched off is still dormant.** The extension stays installed; a reviewer can start it from Control
   Center, and the app says capture is "turned off right now" (`AppEnvironment.swift`). That invites 2.3.1.
3. **It draws the most questions** (ReplayKit, other apps' calls, other people's consent), and mic, import and
   scan cover the core use. Call capture can ship in 1.1 with proof 5 and §1.1.

Removing it is a code change, so it restarts the 7-day soak: do it before RC1.
- `apps/ios/project.yml`: drop the `BroadcastExtension` dependency and its entries from the `AlgoMinutes`
  scheme for Release; keep the target for Staging if testers use it. Check the device lane's
  `AlgoMinutes-ReleaseUITests` scheme (#528) at the same time.
- `Info.plist`: drop the call-capture clause from `NSMicrophoneUsageDescription`, and in STORE-COMPLIANCE §4.2.
- Check whether the App Group is still needed without the extension; change the manifest and docs together
  (the privacy-answers test will say).
- Production: `TF_VAR_broadcast_capture=off` through the owner's reviewed plan and apply; a saved plan resets
  Cloud Run images, so redeploy after.

If proof 5 passes on a device before 11-05: keep it, leave the switch on, paste §1.1 variant A. Otherwise make
the changes above and paste variant B.

## Drift

Code that contradicts the docs (engineering to fix; the notes are blocked on the first):

- **The free floor is paywalled in the app.** `apps/ios/AlgoMinutes/Models/Entitlement.swift:77-81`:
  `gatesMeteredActions` is true for every `freeFloor` (and `expired`) state, whatever `remainingMinutes` says, and
  `BillingService.guardMeteredAction` (`Services/BillingService.swift:135-137`) then shows "Your free plan is
  limited" instead of recording or importing. The server gives 120 minutes (`free_floor_minutes = 120`). So after
  the trial, or on a device DeviceCheck says has had it (from the second recording, once the first kickoff has
  settled the account on the free floor), "120 free minutes a month" isn't reachable on iPhone. Gating on
  `overQuota`/`remainingMinutes <= 0` would match the server. `BillingService.swift:238` (paywall after the first
  summary) uses the same flag.
- `packages/contracts/src/limits.ts`: `FREE_FLOOR_MINUTES` is null and "fails safe to 0"; the per-environment
  value (120 in prod) is what counts, and the comment reads as if prod gives 0.

Docs fixed in this update: the runbook's duplicate notes (now a pointer here, with no support address inline),
its "Home > Record a call shows four steps" and "every first recording"; CONSENT §2.2's two-step sheet and the
agreement's place in the flow; this package's claim that transcripts are labelled in the app (only the summary
and Ask AI are; exports label both); the notification prompt's timing (once a recording starts, not after the
first one).

## Not verified

Everything marked so in §1.3 and §5; App Store Connect state.
