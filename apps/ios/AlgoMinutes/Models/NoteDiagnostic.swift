import Foundation

/// A7.4 — turns a note's failure into a plain-English cause plus which pipeline
/// stage it failed at, for `NoteErrorPane`.
///
/// The stage is expressed as a `NoteProcessingStage.Phase` so the error screen
/// names the same stages the processing screen showed — Upload → Transcribe →
/// Summarize — rather than inventing a separate vocabulary. A note in `.error`
/// no longer carries its pre-error status, so the stage is inferred from the
/// structured `diagnosticCode` (populated by the backend, Phase 2) and, failing
/// that, from keywords in the server `errorMessage`.
struct NoteDiagnostic: Equatable {
    /// One plain sentence a non-technical user can act on.
    let cause: String
    /// Which stage failed, if we can tell. Nil when it is genuinely unknown —
    /// never guessed, matching the "no invented detail" rule in NoteProcessingStage.
    let failedPhase: NoteProcessingStage.Phase?

    /// "This happened while transcribing." — nil when the phase is unknown.
    var stageDescription: String? {
        guard let failedPhase else { return nil }
        switch failedPhase {
        case .upload:    return "This happened while uploading the audio."
        case .transcribe: return "This happened while transcribing the audio."
        case .summarize: return "This happened while writing the summary."
        case .ready:     return nil
        }
    }

    static func from(diagnosticCode: String?, errorMessage: String?) -> NoteDiagnostic {
        // Known structured codes (packages/contracts note.ts + services). The set
        // is small today and grows in backend Phase 2; unknown codes fall through
        // to the server message + a keyword-inferred stage.
        switch diagnosticCode {
        case "CLIENT_TIMEOUT":
            return NoteDiagnostic(
                cause: "Processing took longer than expected and timed out before it finished.",
                failedPhase: nil
            )
        case "EMBED_TIMEOUT":
            return NoteDiagnostic(
                cause: "The transcript and summary are ready, but indexing them for search timed out.",
                failedPhase: .summarize
            )
        case "TOO_LARGE":
            return NoteDiagnostic(
                cause: "This recording is larger than we can process right now.",
                failedPhase: .upload
            )
        case "YOUTUBE_PRECONDITION_FAILED":
            return NoteDiagnostic(
                cause: "That video couldn't be fetched — it may be private, age-restricted, or removed.",
                failedPhase: .upload
            )
        default:
            let trimmed = errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
            let cause = (trimmed?.isEmpty == false)
                ? trimmed!
                : "We couldn't analyse this recording."
            return NoteDiagnostic(
                cause: cause,
                failedPhase: inferPhase(diagnosticCode: diagnosticCode, errorMessage: errorMessage)
            )
        }
    }

    /// Best-effort stage inference from free text. Returns nil rather than
    /// guessing when nothing matches.
    private static func inferPhase(diagnosticCode: String?, errorMessage: String?) -> NoteProcessingStage.Phase? {
        let haystack = "\(diagnosticCode ?? "") \(errorMessage ?? "")".lowercased()
        if haystack.contains("upload") || haystack.contains("download")
            || haystack.contains("fetch") || haystack.contains("too large") {
            return .upload
        }
        if haystack.contains("transcri") || haystack.contains("chunk") || haystack.contains("audio") {
            return .transcribe
        }
        if haystack.contains("summ") || haystack.contains("embed") || haystack.contains("index") {
            return .summarize
        }
        return nil
    }
}
