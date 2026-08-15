# CONSENT — Recording Consent Policy (A10 #2)

> Launch-blocker artifact. Scope: what v1.0 **ships** for recording consent, and the
> deeper legal layer the code **must not implement or guess** before a written legal
> opinion exists. Publisher: **Algorythmos Pty Ltd** (Sydney, NSW, Australia), shipping
> globally on iOS + Android. Web reads/manages/pays and does **not** capture audio, so it
> is out of scope for the capture-consent flow (but see §6 for the signup-time policy
> acceptance shared with all clients).

---

## 1. Position in one paragraph

AlgoMinutes is a general-audience recorder. It cannot know, at record time, which
jurisdiction the user is in, who else is in the room, or whether the conversation is
"private" in the legal sense. Rather than encode a guess about consent law into the
recorder, v1.0 ships a **conservative default recording behaviour** plus a **prominent,
plain-English, per-session pre-recording notice** that places the consent obligation
explicitly on the user, and records that they accepted it. The full jurisdiction-aware
consent layer (§4) is deliberately **deferred to a written legal opinion** and is wired
behind a single recorder **seam** (§5) so it can be added later without reworking capture.

---

## 2. What v1.0 ships (the conservative default + notice) — DOCUMENTED, in code today

### 2.1 Conservative default recording behaviour

- **Recording never starts silently or automatically.** There is no auto-record, no
  "always on", no background auto-capture. Every recording is an explicit, foregrounded
  user action.
- **A per-session affirmative gate is required before every capture.** The consent
  checkbox is re-presented **every session** (not "once and remembered") — parity is
  enforced across iOS and web.
- **Mic-only by default.** Device-mic capture is the primary path. App-audio capture (iOS
  ReplayKit broadcast extension / Android MediaProjection) is a separate, user-initiated
  action with its own OS-level permission prompt, so the platform itself forces a second
  conscious step.
- **The user is always shown that recording is in progress** (in-app recording screen +,
  on Android, a persistent foreground-service notification required by
  `FOREGROUND_SERVICE_MICROPHONE` / `mediaProjection`). This is a de-facto "recording
  indicator", not an audible announcement (see §4).
- **Local audio is retained only until a confirmed upload, then purged** (see
  `docs/DATA-RETENTION.md` §5 and `RecordingStore`). Conservative retention is part of the
  conservative default.

### 2.2 The prominent, plain-English pre-recording notice (as shipped)

iOS presents a **two-step sheet** (`apps/ios/AlgoMinutes/Features/Recorder/RecorderFlow.swift`),
mirrored by the web `InstantRecorderConsent` component:

- **Step 1 — "Ready to record?"** Plain-English statement of what happens:
  > "AlgoMinutes records audio from this device for as long as you're recording.
  > Afterwards it's transcribed and summarised for you. You can stop at any time."

- **Step 2 — "Before you record"** A first-run explainer of where the audio goes and how
  long it is kept, plus a checkbox that is **mandatory every session**:
  > "I have permission from anyone whose voice may be captured. If others are present,
  > I'll let them know the meeting is being recorded."

  The "Start recording" button is **disabled until the box is ticked** ("Tick the box to
  start"). This is the shipped consent affirmation.

**Why this wording is defensible as a v1.0 floor:** it (a) discloses capture, purpose, and
storage in plain English; (b) makes the user affirm they have the right to record the
other participants; and (c) does so before every capture, not once. It is a
responsibility-shifting notice, **not** a substitute for the jurisdiction-aware layer in §4.

### 2.3 `TODO(legal)` on the shipped copy

- `TODO(legal):` Confirm the exact wording of the Step-2 affirmation is adequate as a
  responsibility-shift/indemnity-style notice for a consumer product distributed globally,
  and whether it should reference the Terms/Privacy Policy inline. Do **not** re-word it to
  assert any specific legal standard is met until reviewed.
- `TODO(brand):` Final visual treatment of the consent sheet (icon, emphasis) — copy is
  frozen pending `TODO(legal)`; artwork only.

---

## 3. What v1.0 deliberately does NOT do

The recorder does **not** attempt any of the following, and must not have them added
ad hoc by a well-meaning change:

- It does not detect the user's jurisdiction and branch behaviour on it.
- It does not implement a per-participant consent flow or store a per-participant consent log.
- It does not play an audible "this call is being recorded" announcement.
- It does not claim, in copy or UI, that recording is "legal" or "compliant" anywhere.
- It does not enforce all-party vs one-party rules.

These are the §4 layer, and they are **blocked on a legal opinion that has not been
commissioned.** Guessing them in code is worse than omitting them, because a wrong
jurisdiction rule creates false assurance.

---

## 4. `TODO(legal):` the full consent layer — specify, do NOT implement or guess

> **None of the following may be built until a written legal opinion is commissioned and
> received.** State-by-state and country-by-country consent rules must **not** be inferred
> from general knowledge, this document, or model output. This section is a specification
> of the *questions* for counsel and the *shape* of the eventual feature — not an
> instruction to build.

### 4.1 Jurisdiction awareness

- Australia is **state-based**, not uniform. As a general (non-authoritative) illustration
  only: **NSW** (the publisher's home state, *Surveillance Devices Act 2007 (NSW)*)
  generally requires **all-party consent** to record a **private conversation**; other
  states/territories differ, and some distinguish being a party to the conversation.
  Overseas regimes (US two-party states like California, the EU/GDPR, UK, Canada) differ
  again.
- `TODO(legal):` A written opinion mapping, at minimum: AU per-state rules; the major
  export markets; the definition of "private conversation" that applies; and whether
  being a party to the conversation changes the obligation. **This opinion has not been
  commissioned.** Until it exists, no per-jurisdiction branching ships.
- Implementation note for *later*: jurisdiction would be resolved at the seam (§5), not
  guessed in the UI. Signals available without new tracking: store storefront/region,
  device locale/region, and (only if the opinion requires it) an explicit user selection.
  Firebase Analytics is **off** (A6 decision) and geolocation is **not** collected — a
  jurisdiction feature must not silently introduce either.

### 4.2 Pre-recording consent flow (per participant)

- `TODO(legal):` Whether the app must obtain consent from **each** participant (not just
  an attestation from the recording user), and if so what form satisfies the law (verbal
  captured on the recording, a shared link each participant taps, a read-aloud script).
- Design constraint for *later*: this must slot in front of `RecorderService.start()` via
  the seam (§5) so that "capture is blocked until consent state = satisfied" is enforced
  in one place across mic and app-audio paths.

### 4.3 Per-participant consent log

- `TODO(legal):` Whether a **durable, tamper-evident consent record** is required
  (who consented, when, by what method), how long it must be retained, and whether it must
  be produceable on request. If required, it becomes a first-class data type in
  `docs/STORE-COMPLIANCE.md` and `docs/DATA-RETENTION.md` (new Postgres table, new
  Data-Safety/Nutrition-Label entry). **Do not** create such a table speculatively — it is
  itself sensitive data.

### 4.4 Audible announcement

- `TODO(legal):` Whether an audible "this conversation is being recorded" announcement is
  required or advisable, per jurisdiction, and whether it must be captured *in* the
  recording as evidence. Design note for *later*: an announcement would be triggered at the
  seam (§5) immediately before capture begins, and (if counsel requires) written to the
  head of the audio file.

### 4.5 Retention controls tied to consent

- `TODO(legal):` Whether consent can be **withdrawn** mid- or post-recording and what that
  obligates (immediate deletion of a specific participant's audio is not technically
  separable from the recording — flag this constraint to counsel). Retention mechanics
  themselves are specified in `docs/DATA-RETENTION.md`; this item is only the
  *consent-driven* subset.

---

## 5. The recorder SEAM — where the §4 layer slots in later

The full layer must be addable **without reworking the recorder**. The seam is a single
consent gate evaluated *before capture starts*, on every capture path.

### 5.1 iOS

- Capture starts in `RecorderService.start()`
  (`apps/ios/AlgoMinutes/Services/RecorderService.swift`). Today the first two guards are:
  ```
  guard recorder == nil else { throw RecorderError.alreadyRecording }
  guard await requestPermission() else { throw RecorderError.permissionDenied }
  ```
- **Seam definition:** introduce a `ConsentGate` async check as the guard *immediately
  after* `requestPermission()` and *before* the disk/session/`AVAudioRecorder` setup:
  ```
  // SEAM (A10 §4): the jurisdiction-aware consent layer plugs in here.
  // v1.0 ships a gate whose only implementation is "the per-session
  // consent checkbox in RecorderConsentFlow was ticked". §4 replaces the
  // gate's body; the call site does not change.
  guard try await consentGate.satisfied(for: captureKind) else {
      throw RecorderError.consentNotSatisfied
  }
  ```
- Because both the mic path and the app-audio (broadcast) path funnel intent through the
  consent sheet before invoking capture, a single gate covers both. The **UI** (the
  `RecorderConsentFlow` sheet) and the **enforcement point** (`start()`) are already
  separated, which is what makes the seam clean.

### 5.2 Android

- Capture starts in the foreground services (`RecordingService.kt` /
  `BroadcastRecordingService.kt`, `AudioRecorder.kt` / `BroadcastAudioRecorder.kt`).
  Note the recorder Activity/consent flow on Android is tracked as **B2** (see
  `docs/BLOCKERS.md`) — build the same seam there: a `ConsentGate.satisfied(...)` check
  gating `startForeground(...)` / recorder init, not scattered through the service.

### 5.3 Seam invariants

- **One gate, all paths.** No capture path may start without passing the gate.
- **The gate returns a decision, never assumes one.** v1.0's gate returns "satisfied" iff
  the per-session checkbox was ticked. §4 changes *what makes it satisfied*; callers are
  untouched.
- **The gate is where jurisdiction, per-participant consent, announcement trigger, and the
  consent-log write will live** — so adding them is an implementation change to one type,
  not a recorder rewrite.

---

## 6. Signup-time policy acceptance (shared with STORE-COMPLIANCE)

- Timestamped acceptance of **Terms** + **Privacy Policy** at signup is required (see
  `docs/STORE-COMPLIANCE.md`). This is distinct from per-session recording consent: it
  governs the user's relationship with AlgoMinutes; §2/§4 govern the *other people* in a
  recording.
- Guest mode (anonymous Firebase identity → permanent) must still surface the same consent
  sheet before capture; anonymity of the *account* does not lower the consent bar for
  *participants*.

---

## 7. Open items summary

| Item | Type | Blocking? |
|---|---|---|
| State-by-state + export-market consent opinion (§4.1) | `TODO(legal)` — **not yet commissioned** | Blocks all of §4 |
| Adequacy of shipped Step-2 affirmation wording (§2.3) | `TODO(legal)` | Not blocking launch; review recommended pre-launch |
| Per-participant consent flow + log requirement (§4.2/§4.3) | `TODO(legal)` | Blocks that feature only |
| Audible announcement requirement (§4.4) | `TODO(legal)` | Blocks that feature only |
| Consent-sheet visual treatment (§2.3) | `TODO(brand)` | Not blocking |
| Android consent seam (§5.2) | Eng (B2) | Blocks Android capture parity |
