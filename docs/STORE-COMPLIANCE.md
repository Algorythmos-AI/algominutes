# STORE-COMPLIANCE — App Store & Play Store Privacy/Compliance (A10 #3)

> Launch-blocker artifact. Publisher: **Algorythmos Pty Ltd** (Sydney, AU), shipping
> globally. This document is the single source for the store privacy declarations and must
> stay in sync with `apps/ios/AlgoMinutes/PrivacyInfo.xcprivacy`,
> `apps/ios/AlgoMinutes/Info.plist`, `apps/android/app/src/main/AndroidManifest.xml`, and
> `docs/DATA-RETENTION.md`.
>
> **Load-bearing fact:** Firebase Analytics is **OFF** (A6.9 / A10 decision — no
> `getAnalytics()` call exists in any client). Every declaration below therefore answers
> **"analytics / tracking = NONE"**. That is a deliberate choice, not the form default —
> do not "helpfully" tick analytics because most apps do.

---

## 1. Real data-flow inventory (source of truth for both stores)

| # | Data collected | Why (purpose) | Where it goes | Linked to user? | Used for tracking? | Retention (see DATA-RETENTION) |
|---|---|---|---|---|---|---|
| 1 | **Audio recordings** (device mic and/or app audio) | Core function — to transcribe & summarise | Stored in **Cloud Storage** (GCS) in **Australia** (`australia-southeast1`). Longer recordings are transcribed by **Google Cloud Speech-to-Text on its `global` endpoint** (`stt.js`, `STT_PROVIDER=google`), so audio **may be processed outside Australia**; short clips are transcribed by Gemini on Vertex AI in `australia-southeast1`. AssemblyAI is a code path (ADR 0005) that isn't enabled. | Yes (to uid/workspace) | No | Until user deletes; local device copy purged after confirmed upload; provider copy deleted after processing |
| 2 | **Transcripts** (user content derived from audio) | Core function — the readable record + summaries/action items | **Postgres** (source of truth: `transcript_lines`, `summaries`, `action_items`, `key_decisions`, `embeddings`) + **Firestore** cache | Yes | No | Until user deletes / user-set retention |
| 3 | **Account email + Firebase uid** | Account identity, auth, workspace membership | **Firebase Auth** + **Postgres** (`users`, `workspace_members`) + **Firestore** cache | Yes | No | Until account deletion |
| 4 | **Device push token (FCM)** | Notify user when a recording is transcribed/ready | **FCM** + stored server-side to target the device | Yes | No | Until token rotates / account deletion |
| 5 | **Diagnostic context** (structured server logs: traceId, uid, noteId, workspaceId, error events; client crash/error state) | Reliability, debugging, abuse prevention | Server logs (Cloud Logging) — **not** an analytics product | Yes (uid present in log lines) | No | Log retention window (see DATA-RETENTION §logs) |
| 6 | **Billing/subscription state** | Manage paid plan / reverse trial | Stripe (web rail) / App Store / Play Billing + Postgres | Yes | No | Per payment-processor + tax record rules |
| 7 | **Consent affirmation (per-session checkbox)** | Record that the pre-recording notice was accepted | Client state (`instant_recorder_consent_shown`) today; a durable per-participant log is `TODO(legal)` (see CONSENT §4.3) | Device-local today | No | n/a today |

Notes:
- **No advertising identifiers, no third-party analytics/ad SDKs, no cross-app/site
  tracking, no location.** This is what "tracking = NONE" means concretely.
- Camera / Photo Library (see §4) are used for **on-device text scanning input** and the
  scanned image is treated as **user content** (same class as transcripts) if uploaded.
- **Cross-border processing (as deployed, 2026-09-26):** storage, Postgres, Firestore and Vertex AI
  (Gemini, embeddings) are in Australia (`australia-southeast1`). Speech-to-Text runs on Google's
  `global` endpoint, and Firebase Auth, FCM/APNs, Crashlytics and Cloud Logging are global services,
  so some processing may happen outside Australia. The published Privacy Policy
  (`apps/site`, "Information sent outside Australia") says so under APP 8, rendered from
  `apps/site/src/data/processing.json`, which `tests/site-facts.test.ts` checks against Terraform and
  the code. **If AssemblyAI is enabled** (`STT_PROVIDER=assemblyai`), that test fails until the
  policy names it, and the training opt-out below becomes a precondition of the "not shared" answers.

---

## 2. Apple Privacy Nutrition Labels (App Store Connect answers)

Answer the App Privacy questionnaire as follows. For **every** data type: *Used for
Tracking?* = **No**; *Linked to the user?* = **Yes** (all data is tied to the account).

| Nutrition Label data type | Collected? | Purpose(s) | Linked | Tracking |
|---|---|---|---|---|
| Audio Data | **Yes** | App Functionality | Yes | No |
| Other User Content (transcripts, scanned text/images) | **Yes** | App Functionality | Yes | No |
| Email Address | **Yes** | App Functionality, Account Management | Yes | No |
| User ID (Firebase uid) | **Yes** | App Functionality | Yes | No |
| Device ID / Push token | **Yes** | App Functionality (notifications) | Yes | No |
| Purchase History / subscription | **Yes** | App Functionality | Yes | No |
| Crash Data / Diagnostics | **Yes** | App Functionality (diagnostics) | Yes | No |
| **Usage Data / Analytics** | **No** | — | — | — |
| **Identifiers for advertising / tracking** | **No** | — | — | — |
| Location, Contacts, Health, Financial info, Browsing history | **No** | — | — | — |

- **"Data Used to Track You" section: empty.** Confirm this matches `NSPrivacyTracking =
  false` in the `.xcprivacy` files.
- `TODO(legal):` Confirm whether "Purchase History" and "Crash Data" should be declared as
  Linked vs Not-Linked given they always carry uid — recommend Linked (conservative).

---

## 3. Google Play Data Safety (Play Console form answers)

| Data category → type | Collected | Shared | Purpose | Processed ephemerally? | Optional? |
|---|---|---|---|---|---|
| **Audio → Voice or sound recordings** | Yes | No¹ | App functionality | No (stored in AU; processed then deleted by the US STT sub-processor) | No (core) |
| **Files & docs / User content → Other user-generated content** (transcripts, scanned text) | Yes | No | App functionality | No | No |
| **Personal info → Email address** | Yes | No | Account management, App functionality | No | No |
| **Personal info → User IDs** (uid) | Yes | No | App functionality | No | No |
| **Device or other IDs** (FCM push token) | Yes | No | App functionality (notifications) | No | No |
| **App activity → App interactions / Analytics** | **No** | — | — | — | — |
| **App info & performance → Crash logs / Diagnostics** | Yes | No | App functionality (diagnostics) | No | No |
| **Financial info → Purchase history** | Yes | No | App functionality | No | No |
| **Location** | **No** | — | — | — | — |

¹ **Sharing = No.** Under Play's Data Safety definition, transferring data to a *service
provider that processes it on your behalf* is not "sharing." Google Cloud (Speech-to-Text,
Vertex AI) processes our content only on our behalf and doesn't train on it. **If AssemblyAI is
enabled**, it becomes a sub-processor under the same carve-out, but only while it does **not** use
our content for its own purposes. AssemblyAI trains on customer data by default, so enabling it
needs the account-level model-training opt-out first (paid plan; see BLOCKERS), or this answer
becomes "Yes (shared)".

Play form global answers:
- **Does your app collect or share any of the required user data types?** Yes (collect).
  **No sharing** with third parties — Google Cloud and Firebase are processors acting on our
  behalf under their data processing terms, not recipients we "share" with (footnote ¹).
- **Cross-border:** storage and Vertex AI are in Australia; Speech-to-Text (global endpoint) and
  the global Firebase services may process data outside Australia. Disclosed in the Privacy
  Policy (APP 8).
- **Is all collected data encrypted in transit?** Yes (HTTPS/TLS). State it.
- **Do you provide a way for users to request that their data is deleted?** **Yes** — see
  §6 (in-app **and** a web-accessible deletion request URL — Play requires the URL).
- **Does your app use any advertising or analytics?** **No.**

---

## 4. iOS: exact `PrivacyInfo.xcprivacy` + `Info.plist` entries

### 4.1 `PrivacyInfo.xcprivacy` — required entries (app target)

Current file already declares `NSPrivacyTracking=false`, empty `NSPrivacyTrackingDomains`,
and collected types **EmailAddress / AudioData / UserID** (all `Linked=true`,
`Tracking=false`, purpose `AppFunctionality`). **Required additions/confirmations:**

- **Keep:** `NSPrivacyTracking = false`; `NSPrivacyTrackingDomains = <empty array>`.
- **Keep:** collected data types `NSPrivacyCollectedDataTypeEmailAddress`,
  `NSPrivacyCollectedDataTypeAudioData`, `NSPrivacyCollectedDataTypeUserID`
  (Linked=true, Tracking=false, purpose `NSPrivacyCollectedDataTypePurposeAppFunctionality`).
- **ADD** `NSPrivacyCollectedDataTypeOtherUserContent` (transcripts + scanned text/images)
  — Linked=true, Tracking=false, purpose AppFunctionality.
- **ADD** `NSPrivacyCollectedDataTypeDeviceID` (FCM push token) — Linked=true,
  Tracking=false, purpose AppFunctionality.
- **ADD** `NSPrivacyCollectedDataTypeCrashData` — Linked=true, Tracking=false, purpose
  AppFunctionality (diagnostic context).
- **API-usage reasons — keep the two already present, confirm sufficiency:**
  - `NSPrivacyAccessedAPICategoryUserDefaults` → reason **`CA92.1`** (app's own defaults;
    the consent flag `instant_recorder_consent_shown` lives here).
  - `NSPrivacyAccessedAPICategoryFileTimestamp` → reason **`C617.1`** (RecordingStore
    reads file timestamps for the local upload lifecycle).
  - `TODO(eng):` If the disk-space guard's `volumeAvailableCapacity...` counts as
    **`NSPrivacyAccessedAPICategoryDiskSpace`**, add it with reason **`E174.1`** /
    **`85F4.1`** as applicable. Verify against the current API list before shipping.
- **Broadcast extension target** (`apps/ios/BroadcastExtension/PrivacyInfo.xcprivacy`):
  mirror `NSPrivacyTracking=false` + empty domains; declare **AudioData** (app-audio
  capture). Keep it minimal — the extension captures, it does not manage accounts.

### 4.2 `Info.plist` — rewritten usage descriptions (specific: what / why / where)

Replace the current strings with these (specific about what is recorded, why, and that it
leaves the device):

- **`NSMicrophoneUsageDescription`**
  > "AlgoMinutes records audio from your microphone only while you are recording a meeting
  > or note. The audio is uploaded to your AlgoMinutes account to be transcribed and
  > summarised, and is kept there until you delete it. Recording never starts on its own."

- **`NSCameraUsageDescription`**
  > "AlgoMinutes uses the camera only when you choose to scan text from a document. The
  > captured image is used to extract text into your notes and, if saved, is stored in
  > your account until you delete it. It is never used for tracking or advertising."

- **`NSPhotoLibraryUsageDescription`**
  > "AlgoMinutes opens your photo library only when you pick an image to scan text from.
  > Only the image you choose is read; it is used to extract text into your notes and is
  > not scanned for any other purpose."

- `TODO(legal):` Confirm the microphone string's "kept until you delete it" phrasing is
  consistent with the final retention policy in `docs/DATA-RETENTION.md`.

---

## 5. Android permission rationales

Manifest declares: `INTERNET`, `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`,
`POST_NOTIFICATIONS`; services typed `microphone` and `mediaProjection|microphone`.

Runtime rationale copy (show before/with the OS prompt) and Play Console declarations:

- **`RECORD_AUDIO`**
  > "AlgoMinutes needs the microphone to record the meeting or note you're capturing. The
  > audio is uploaded to your account to be transcribed and summarised, then kept until
  > you delete it. Recording only happens while you're actively recording."

- **`POST_NOTIFICATIONS`**
  > "Allow notifications so AlgoMinutes can tell you when a recording has finished
  > transcribing and your summary is ready, and to show the ongoing 'recording in
  > progress' notice."

- **`FOREGROUND_SERVICE_MICROPHONE`** (Play "Foreground service" declaration required)
  > "AlgoMinutes keeps recording reliably in the background while you use other apps by
  > running a foreground service with a persistent notification. It is used only for
  > microphone recording that you started, for the duration of the recording."
  - Play declaration: foreground service type **microphone**; justification = user-started
    meeting/voice recording; user is always aware via the persistent notification.

- **MediaProjection** (`FOREGROUND_SERVICE_MEDIA_PROJECTION`, type
  `mediaProjection|microphone`)
  > "To record audio from another app (for example a video call), AlgoMinutes uses
  > Android's screen/media capture, which you approve in a system dialog each time. It is
  > used only to capture audio for your recording — no screen content is stored — and only
  > while you are recording."
  - `TODO(legal):` Confirm the MediaProjection justification text meets Play's current
    MediaProjection policy (media-projection use is scrutinised; capture must be
    user-initiated, foreground, and clearly disclosed). Verify against current policy at
    submission time.

- **`INTERNET` / `FOREGROUND_SERVICE`**: infrastructure permissions, no separate runtime
  rationale; covered by the above.

---

## 6. Account-deletion story (end-to-end, both stores) + web deletion page

Both stores require an in-app account-deletion path; Play additionally requires a
**web-accessible deletion request URL** in the store listing.

### 6.1 In-app deletion (iOS + Android + web)

- Authenticated endpoint: **`services/api` `routes/delete-account.js`** (`POST|DELETE
  /v1/account/delete`), self-authenticating via `verifyIdToken`. Postgres first, Auth last:
  1. **Postgres, in one transaction:** a purge is queued for every note the account owns,
     then the `users` row goes and `ON DELETE CASCADE` removes the rest (transcripts,
     embeddings, summaries, action items, decisions, chunks). A tombstone
     (`account_deletions`) records the owned workspaces. If this fails, nothing else
     happens and the client retries.
  2. **The purges:** each note's Firestore doc and audio.
  3. **The account's own Firestore docs** (workspaces and their subcollections, analytics,
     rate-limit counter), then any leftover uploads under its storage prefixes.
  4. **The Firebase Auth user**, last; then the tombstone is marked complete.
  - 200 only when everything is gone. Any failure in 2–4 answers 500 with Auth intact, so
    the client retries; if it never does, the sweeper finishes from the tombstone. Every
    step is idempotent.
  - **Sign in with Apple:** the iOS app revokes the user's Apple token before deleting
    (App Store 5.1.1(v); `AppleTokenRevocationTests`).
- **Local device audio** is already purged after confirmed upload; on account deletion any
  remaining pending recordings are removed by `RecordingStore` (see DATA-RETENTION §5).
- **Guest mode:** anonymous Firebase identities can delete the same way (uid-scoped);
  document that a guest who never upgraded still has a deletion path.

### 6.2 Web-accessible deletion request page (Play requirement)

- **URL:** `https://algominutes.algorythmos.com/delete-account` (the site, `apps/site`)
  (must be publicly reachable without installing the app; submit this exact URL in Play
  Console "Data deletion").
- **What it does (built, `apps/site/src/pages/delete-account.astro`):** the in-app path
  (Settings → Delete my account, type DELETE), an **email request** to `privacy@algorythmos.com`
  from the sign-in address (with the User ID if the user has it), answered within 30 days, what
  deletion removes, and the window: live data at once, backups within 30 days
  (`docs/DATA-RETENTION.md` §4). No backend is needed for Play.
- **Later (plan Phase 3, with the web app):** a **"Sign in and delete now"** button that calls the
  same `/v1/account/delete` endpoint.
- `TODO(legal):` Confirm the page's stated retention/propagation window and that
  "what is kept vs deleted" matches the Privacy Policy exactly.

---

## 7. Age ratings (deliberate recommendation)

### Apple
- Apple's age ratings are now **4+, 9+, 13+, 16+ and 18+** (the questionnaire changed in 2025).
  **Provisional: 13+** (plan decision D8), matching the recording-consent posture and the Terms'
  minimum age; `TODO(legal)` confirms it.
- *Earlier recommendation, kept for its reasoning:* **4+**, *with* the honest content declarations. AlgoMinutes has no
  objectionable content of its own. However, it is a **UGC / recording** app: user-created
  recordings and AI-generated summaries are unmoderated user content.
- `TODO(legal):` Confirm whether the App Store's UGC expectations (moderation, reporting,
  blocking) apply to a **private, single-user** notes app where content is not shared to
  other users. If any sharing/collaboration surfaces exist, a **12+/17+** and UGC controls
  may be required. Default to 4+ only if content is not user-to-user public.

### Google Play
- **Recommend: complete the IARC questionnaire honestly → expected "Everyone".** Declare:
  no violence/sexual/gambling content; **does** allow user-generated content (recordings)
  that is private to the account. Declare the app **is not** directed to children (see
  below).

### Both — not child-directed
- **Target audience: adults / general (18+ intent, not "designed for families").** Declare
  the app is **not** primarily child-directed to stay out of Apple "Made for Kids" and
  Google "Designed for Families" / COPPA obligations. A recording app collecting audio
  should not target children.
- `TODO(legal):` Confirm the minimum-age gate at signup (recommend 16+ or per Terms) and
  that it's consistent across Terms, both store questionnaires, and GDPR/Australian Privacy
  Act age-of-consent thresholds.

---

## 8. Signup-time Terms + Privacy acceptance

- **Timestamped acceptance of Terms of Service + Privacy Policy at signup is required** and
  must be stored server-side (uid, doc version, timestamp). Applies to email, Google, and
  **guest→permanent** upgrade paths.
- `TODO(legal):` Terms + Privacy Policy documents themselves (drafting/review) — not yet
  commissioned. Must exist and be linked from both store listings and the consent sheet
  before launch.

---

## 9. Open-items summary

| Item | Type |
|---|---|
| Terms of Service + Privacy Policy drafting/review (§8) | `TODO(legal)` — **blocking** |
| UGC/moderation applicability + final age rating (§7) | `TODO(legal)` — blocking rating submission |
| MediaProjection justification vs current Play policy (§5) | `TODO(legal)` |
| ~~Add OtherUserContent / DeviceID / CrashData to `.xcprivacy` (§4.1)~~ | ✅ Declared in `PrivacyInfo.xcprivacy` |
| DiskSpace API-reason verification (§4.1) | Eng |
| ~~Final deletion-page domain + support email (§6.2)~~ | ✅ Decided 2026-09-26; the page ships with `apps/site` |
| Confirm retention wording parity across plist/policy/page (§4.2, §6.2) | `TODO(legal)` |
