import Foundation

/// Works out what to show as a transcript line's speaker, and what to leave in
/// the line's text.
///
/// The two pipelines disagree about where the speaker lives, and both reach
/// this screen:
///
/// - **Fast path** (notes under ~10 min): Gemini transcribes in one pass and
///   the speaker is embedded *in the text* as `"Speaker 1: …"`, with
///   `speaker_tag = NULL` (`services/transcoder/src/fast-path.js:82`).
/// - **Chunked path** (longer notes): STT stores `speaker_tag` separately —
///   though diarization is off in production, so it is NULL there too
///   (ADR 0005, Bug 17).
///
/// Rendering both without reconciling them produced a chip reading "Speaker"
/// above text reading "Speaker 1: …" on every line of every short note.
enum SpeakerLabel {
    /// Matches a leading `Speaker 1:` / `Speaker:` / `SPEAKER 2 :` prefix.
    /// Deliberately narrow — it must not eat a line that genuinely opens with
    /// someone talking *about* a speaker.
    private static let embedded = try? NSRegularExpression(
        pattern: #"^\s*(speaker\s*(\d+)?)\s*:\s*"#,
        options: [.caseInsensitive]
    )

    /// Split a raw line into the chip label and the text to display.
    ///
    /// An embedded prefix wins over the stored field, because it carries the
    /// speaker *number* the fast path actually determined — the stored field
    /// in that case is the placeholder "Speaker", which says nothing.
    ///
    /// Returns an empty label when there is no real attribution. A chip
    /// reading "Speaker" on every row implies an attribution the data does not
    /// support, which is worse than no chip at all.
    static func split(speaker: String?, text: String) -> (label: String, text: String) {
        if let embedded, let m = embedded.firstMatch(
            in: text, range: NSRange(text.startIndex..., in: text)
        ) {
            let stripped = String(text[Range(m.range, in: text)!.upperBound...])
            // Only take the prefix when something is left; a line that is
            // *only* "Speaker 1:" should keep its text rather than go blank.
            if !stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // A numbered prefix is a real distinction and becomes a chip.
                // A bare "Speaker:" is not: it is worth stripping from the
                // text, but rendering it as a chip would imply an attribution
                // the data does not support — the same rule display() applies.
                var label = ""
                if m.numberOfRanges > 2, let numRange = Range(m.range(at: 2), in: text) {
                    label = "Speaker \(text[numRange])"
                }
                return (label, stripped)
            }
        }
        return (display(speaker), text)
    }

    /// The chip for an already-separated speaker field.
    ///
    /// Empty, whitespace, or the bare placeholder "Speaker" all mean "no
    /// attribution known" and render no chip.
    static func display(_ speaker: String?) -> String {
        guard let speaker else { return "" }
        let trimmed = speaker.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        if trimmed.caseInsensitiveCompare("Speaker") == .orderedSame { return "" }
        return trimmed
    }
}
