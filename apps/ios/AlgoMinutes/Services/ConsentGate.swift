import Foundation

/// Which capture path is about to start. The v1.0 gate treats both the same,
/// but the §4 layer (jurisdiction, per-participant consent, audible
/// announcement) may branch on this — so the recorder passes it through today
/// even though it is not yet consulted. See `docs/CONSENT.md` §5.
enum CaptureKind: Sendable {
    /// Device-microphone capture — the primary path (`RecorderService`).
    case microphone
    /// App-audio capture via the ReplayKit broadcast extension.
    case appAudio
}

/// The recorder SEAM (A10 #2 / `docs/CONSENT.md` §5).
///
/// A single consent decision evaluated *before capture starts*, on every
/// capture path. v1.0 ships a gate whose only implementation is "the
/// per-session pre-recording notice was acknowledged" (the checkbox in
/// `RecorderConsentFlow`). The full jurisdiction-aware layer (§4) — per-state
/// rules, per-participant consent, a consent log, an audible announcement —
/// slots in by replacing the gate's body. **The call site in
/// `RecorderService.start()` does not change.**
///
/// Deliberately does NOT encode any jurisdiction rule. Guessing one in code is
/// worse than omitting it (it creates false assurance), so v1.0 records only
/// that the user affirmed the notice and shifts the consent obligation to them.
@MainActor
protocol ConsentGate: AnyObject {
    /// Returns true iff capture of `kind` is permitted to begin right now.
    /// The gate returns a decision; it never assumes one.
    func satisfied(for kind: CaptureKind) async -> Bool
}

/// v1.0 gate: satisfied iff the user acknowledged the per-session pre-recording
/// notice in `RecorderConsentFlow`.
///
/// The acknowledgement is per app session (in-memory). The consent UI already
/// re-presents the mandatory checkbox every time the sheet opens (parity with
/// the web `InstantRecorderConsent`, `docs/CONSENT.md` §2.1), so this object's
/// only job is to make "capture is blocked until the notice was acknowledged"
/// enforceable in ONE place, across the mic and app-audio paths — rather than
/// scattered through the recorder.
///
/// TODO(A10 §4, legal): the §4 layer replaces `satisfied(for:)`'s body with the
/// real, jurisdiction-aware decision (and the per-participant consent-log
/// write). Blocked on a written legal opinion that has not been commissioned —
/// do NOT infer state-by-state rules here. The callers stay untouched.
@Observable
@MainActor
final class SessionConsentGate: ConsentGate {
    /// Whether the pre-recording notice has been acknowledged this session.
    private(set) var acknowledgedThisSession = false

    /// Called by `RecorderConsentFlow` when the user ticks the mandatory box
    /// and taps "Start recording". This is the single v1.0 input to the gate.
    func acknowledge() {
        acknowledgedThisSession = true
    }

    /// Clear the acknowledgement — e.g. on sign-out, so a shared device does
    /// not carry one user's affirmation into the next user's session.
    func reset() {
        acknowledgedThisSession = false
    }

    func satisfied(for kind: CaptureKind) async -> Bool {
        // v1.0: the only thing that satisfies the gate is an acknowledged
        // notice. §4 will replace this body (jurisdiction resolution,
        // per-participant consent, announcement trigger, consent-log write).
        if !acknowledgedThisSession {
            AppLog.info("consent_gate_blocked kind=\(kind)")
        }
        return acknowledgedThisSession
    }
}
