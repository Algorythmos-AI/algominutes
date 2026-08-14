import Foundation

/// What the note screen shows while a note is still being processed.
///
/// The competitor screen this is modelled on displays a single percentage.
/// Wassup cannot honestly do that: `progress` is written only by the chunked
/// pipeline (audio over ten minutes), so a short recording goes
/// queued → transcribing → summarizing → ready with no numeric progress at
/// any point. A percentage there would be invented, and the user would catch
/// it the moment it sat still at 52%.
///
/// So the ring is **stage-segmented** — Upload → Transcribe → Summarize →
/// Ready — which is always real, because it is derived from `status`. Within
/// the current segment it goes determinate *only* when a genuine fraction
/// exists: the upload percentage the client measures itself, or the
/// `done/total` chunk count the server reports.
///
/// The rule this type exists to enforce: `detail` is non-nil only when a real
/// number backs it.
struct NoteProcessingStage: Equatable, Sendable {
    /// Segments of the ring, in order. `ready` is the terminal state and is
    /// never rendered by the processing pane — it is here so the ring can
    /// show how many segments remain.
    enum Phase: Int, CaseIterable, Sendable {
        case upload, transcribe, summarize, ready
    }

    enum Fill: Equatable, Sendable {
        /// No real fraction available — the ring sweeps.
        case indeterminate
        /// A measured fraction of the current segment, 0...1.
        case fraction(Double)
    }

    let phase: Phase
    let fill: Fill
    let label: String
    /// "42%" or "3 of 8". Nil whenever no real number exists — never a guess.
    let detail: String?

    /// Reassurance that this keeps running in the background. Constant on
    /// purpose: it is true at every stage, and varying it would imply the
    /// guarantee changes.
    static let backgroundNotice = "Runs in the background. Safe to leave."

    /// - Parameters:
    ///   - status: the note's pipeline status.
    ///   - progress: chunk counts, written only by the chunked path.
    ///   - uploadPercent: 1...99 while the client is still sending bytes,
    ///     nil once the server owns the work.
    static func from(
        status: NoteStatus,
        progress: NoteProgress?,
        uploadPercent: Int?
    ) -> NoteProcessingStage {
        // The upload is the one phase the client measures directly, so it is
        // the one place a percentage is honest. Bounded to 1...99: 0 means
        // nothing has moved and 100 means the bytes are gone but the server
        // has not acknowledged yet, and neither should read as progress.
        if let percent = uploadPercent, percent > 0, percent < 100 {
            return NoteProcessingStage(
                phase: .upload,
                fill: .fraction(Double(percent) / 100),
                label: "Uploading audio",
                detail: "\(percent)%"
            )
        }

        switch status {
        case .transcribing:
            // The chunked path reports real chunk counts; the fast path
            // reports nothing at all. Same label either way — only the
            // presence of a number differs.
            if let progress, progress.total > 0 {
                return NoteProcessingStage(
                    phase: .transcribe,
                    fill: .fraction(min(1, Double(progress.done) / Double(progress.total))),
                    label: "Transcribing speech to text",
                    detail: "\(progress.done) of \(progress.total)"
                )
            }
            return NoteProcessingStage(
                phase: .transcribe,
                fill: .indeterminate,
                label: "Transcribing speech to text",
                detail: nil
            )

        case .summarizing:
            return NoteProcessingStage(
                phase: .summarize, fill: .indeterminate,
                label: "Writing the summary", detail: nil
            )

        case .chunking:
            return NoteProcessingStage(
                phase: .transcribe, fill: .indeterminate,
                label: "Preparing audio", detail: nil
            )

        case .queued, .processing, .recording:
            return NoteProcessingStage(
                phase: .upload, fill: .indeterminate,
                label: status.label, detail: nil
            )

        case .ready, .error:
            // Not rendered by the processing pane; mapped so the type stays
            // total rather than trapping on a status the caller mis-routed.
            return NoteProcessingStage(
                phase: .ready, fill: .indeterminate,
                label: status.label, detail: nil
            )
        }
    }

    /// Segments already finished — what the ring draws as solid behind the
    /// active one.
    var completedPhases: Int { phase.rawValue }
}
