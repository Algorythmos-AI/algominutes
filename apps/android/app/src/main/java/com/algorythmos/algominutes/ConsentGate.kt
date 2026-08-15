package com.algorythmos.algominutes

/**
 * Recording-consent SEAM (BUILD-PLAN A10 #2 · see `docs/CONSENT.md` §5.2).
 *
 * A single async gate that every capture path consults **immediately before
 * capture starts**. It exists so the deep, jurisdiction-aware consent layer
 * (`docs/CONSENT.md` §4 — per-participant consent flow + log, audible
 * announcement, state-by-state / country rules, consent-driven retention) can
 * be added **later without reworking the recorders**: §4 changes only *what
 * makes the gate satisfied*; the call sites in the recorders never change.
 *
 * ## What v1.0 ships (conservative default — NO jurisdiction rules)
 * The only implementation today is [AllowWithNoticeConsentGate]: it returns
 * `satisfied = true` on the understanding that the B2 Compose UI has shown the
 * prominent, plain-English pre-recording notice and the user ticked the
 * per-session consent checkbox (copy in `res/values/strings.xml`:
 * `consent_notice_*`, mirrored from `docs/CONSENT.md` §2.2 and the iOS
 * `RecorderConsentFlow`). This gate deliberately does **not**:
 * - detect the user's jurisdiction or branch behaviour on it,
 * - implement a per-participant consent flow or log,
 * - play an audible "this call is being recorded" announcement,
 * - claim recording is "legal" / "compliant" anywhere.
 *
 * Those are the §4 layer and are **blocked on a written legal opinion** — do
 * not implement or guess the rules here (`docs/CONSENT.md` §3/§4).
 *
 * ## Seam invariants (`docs/CONSENT.md` §5.3)
 * - **One gate, all paths.** No capture path may start without passing the gate
 *   — both [BackgroundAudioRecorder] (mic) and [BroadcastAudioRecorder]
 *   (MediaProjection app-audio + mic) call it before dispatching to their
 *   foreground service.
 * - **The gate returns a decision, never assumes one.** v1.0 returns
 *   "satisfied" iff the per-session checkbox was ticked (surfaced to this
 *   module by the caller wiring in the real gate). §4 changes the body only.
 * - The recorder cores (`RecordingService`/`BroadcastRecordingService`, §5
 *   protected) are untouched — the gate is a hook in front of `startForeground`.
 *
 * ## TODO(B2) — what the Compose client must finish
 * - Present the two-step pre-recording notice sheet + the mandatory-every-session
 *   consent checkbox (see `consent_notice_*` strings), disabling "Start" until
 *   ticked, then supply a `ConsentGate` whose [satisfied] reflects that tick
 *   (e.g. a gate reading the UI's per-session consent state) to the recorder
 *   constructors in place of the [AllowWithNoticeConsentGate] default.
 * - Do NOT add jurisdiction/per-participant logic here without the legal opinion.
 */
interface ConsentGate {

    /**
     * Whether recording consent is satisfied for [captureKind]. Called on every
     * capture path immediately before capture starts. Returning `false` blocks
     * capture (the recorder reports it and does not start).
     *
     * `suspend` so a future §4 implementation can await UI (present a sheet),
     * network, or a consent-log write without changing callers.
     */
    suspend fun satisfied(captureKind: CaptureKind): Boolean
}

/** Which capture path is asking the gate. A single gate covers both. */
enum class CaptureKind {
    /** Device microphone only — [BackgroundAudioRecorder] / `RecordingService`. */
    MICROPHONE,

    /**
     * App/meeting audio via MediaProjection (mixed with mic) —
     * [BroadcastAudioRecorder] / `BroadcastRecordingService`.
     */
    APP_AUDIO,
}

/**
 * v1.0 conservative-default gate: **allow-with-notice**.
 *
 * Always returns `true`. The consent obligation is discharged by the prominent
 * per-session notice + mandatory checkbox the B2 UI shows *before* invoking the
 * recorder (conservative default per `docs/CONSENT.md` §2). This class holds NO
 * jurisdiction logic by design.
 *
 * TODO(B2): replace with a gate wired to the actual per-session checkbox state
 * (so an un-ticked box blocks capture in-code, not just in-UI). TODO(legal):
 * the full §4 layer slots in behind this same interface once the opinion exists.
 */
class AllowWithNoticeConsentGate : ConsentGate {
    override suspend fun satisfied(captureKind: CaptureKind): Boolean = true
}
