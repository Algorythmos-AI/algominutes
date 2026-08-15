import Foundation

/// How much of a note an export carries.
enum ExportScope: String, CaseIterable, Identifiable, Sendable {
    case summary
    case transcript
    case both

    var id: String { rawValue }

    var label: String {
        switch self {
        case .summary: return "AI Summary"
        case .transcript: return "Transcription"
        case .both: return "AI Summary & Transcription"
        }
    }

    var includesSummary: Bool { self != .transcript }
    var includesTranscript: Bool { self != .summary }

    /// Scopes worth offering for this note. A note with no transcript should
    /// not offer to export one and then produce an empty file.
    static func available(for note: Note, hasTranscript: Bool) -> [ExportScope] {
        let hasSummary = note.summary != nil
        switch (hasSummary, hasTranscript) {
        case (true, true): return [.both, .summary, .transcript]
        case (true, false): return [.summary]
        case (false, true): return [.transcript]
        case (false, false): return []
        }
    }
}

/// Plain-text rendering of a note, and the disclosure that has to travel with
/// every export.
enum NoteExport {
    /// Shown wherever a note leaves the app.
    ///
    /// Transcript text is redacted *before* it is stored
    /// (`services/transcoder/src/db.js`), so an export genuinely contains
    /// `<<REDACTED:…>>` markers and there is no un-redacted copy anywhere to
    /// fall back to. The user should learn that here, not from a colleague
    /// reading a forwarded document.
    static let redactionNotice =
        "Detected card numbers, IDs and contact details are masked. AlgoMinutes never stored the originals."

    static func fileNameStem(for note: Note) -> String {
        var sanitized = note.title.map { ch -> Character in
            (ch.isLetter || ch.isNumber || ch == "-" || ch == "_") ? ch : "_"
        }
        if sanitized.count > 80 { sanitized = Array(sanitized.prefix(80)) }
        // A title of pure punctuation maps to underscores, which is not empty
        // — so an isEmpty check alone would ship "____.pdf". Fall back unless
        // something readable survived. Matches functions/export-note.cjs, so
        // one note exported from either path gets the same name.
        if !sanitized.contains(where: { $0.isLetter || $0.isNumber }) {
            sanitized = Array("Note")
        }
        return String(sanitized)
    }

    static func fileName(for note: Note, scope: ExportScope, ext: String) -> String {
        let suffix: String
        switch scope {
        case .summary: suffix = "_Summary"
        case .transcript: suffix = "_Transcript"
        case .both: suffix = "_Note"
        }
        return fileNameStem(for: note) + suffix + "." + ext
    }

    /// Plain text in the same section order as the PDF, so the two exports of
    /// one note read the same.
    static func plainText(note: Note, scope: ExportScope, lines: [TranscriptLine]) -> String {
        var out: [String] = [note.title, ""]

        if scope.includesSummary, let summary = note.summary {
            out.append("EXECUTIVE SUMMARY")
            out.append(summary.gist.isEmpty ? "No summary." : summary.gist)
            if !summary.actionItems.isEmpty {
                out.append("")
                out.append("ACTION ITEMS")
                out.append(contentsOf: summary.actionItems.map { "- \($0)" })
            }
            if !summary.keyDecisions.isEmpty {
                out.append("")
                out.append("KEY DECISIONS")
                out.append(contentsOf: summary.keyDecisions.map { "- \($0)" })
            }
        }

        if scope.includesSummary, let raw = note.rawText, !raw.isEmpty {
            out.append("")
            out.append("EXTRACTED TEXT")
            out.append(raw)
        }

        if scope.includesTranscript, !lines.isEmpty {
            out.append("")
            out.append("TRANSCRIPT")
            for line in lines {
                // Speaker and timestamp are both optional — diarization is off
                // in production, so most lines have neither.
                let prefix = [line.time, line.speaker]
                    .filter { !$0.isEmpty }
                    .joined(separator: "  ")
                out.append(prefix.isEmpty ? line.text : "[\(prefix)] \(line.text)")
            }
        }

        out.append("")
        out.append(redactionNotice)
        return out.joined(separator: "\n")
    }
}
