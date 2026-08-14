import Foundation

/// Parity with `finalizeExtractedTextNote` in `src/App.tsx`: turns extracted
/// document text into the fields written on a ready `scan_text` note.
enum TextNoteBuilder {
    static let maxChars = 180_000
    static let truncationSuffix = "\n\n[Text truncated for mobile display.]"

    struct Result: Equatable {
        var rawText: String
        var transcript: [TranscriptLine]
        var transcriptTruncated: Bool
        var wordCount: Int
        var gist: String
        var title: String?
    }

    enum SourceKind {
        case scannedImage, pdf, imported

        var label: String {
            switch self {
            case .scannedImage: return "Scanned image"
            case .pdf: return "PDF document"
            case .imported: return "Imported document"
            }
        }
    }

    static func build(text: String, source: SourceKind) -> Result {
        // Strip NULs, normalize.
        var normalized = text.replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        var truncated = false
        if normalized.count > maxChars {
            normalized = String(normalized.prefix(maxChars)) + truncationSuffix
            truncated = true
        }

        let paragraphs = normalized
            .components(separatedBy: CharacterSet.newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        let transcript: [TranscriptLine] = paragraphs.isEmpty
            ? [TranscriptLine(index: 0, speaker: source.label,
                              text: "No text detected in \(source.label.lowercased()).", time: "")]
            : paragraphs.enumerated().map { offset, paragraph in
                TranscriptLine(index: offset, speaker: source.label, text: paragraph, time: "")
            }

        let words = normalized.split(whereSeparator: { $0.isWhitespace })
        let wordCount = words.count

        let firstParagraph = paragraphs.first ?? ""
        let gist = "\(source.label) - \(wordCount) words extracted\(truncated ? " (truncated)" : "").\n\n\(String(firstParagraph.prefix(500)))..."

        let title: String? = paragraphs
            .first(where: { $0.count >= 5 })
            .map { $0.count > 60 ? String($0.prefix(60)) + "..." : $0 }

        return Result(
            rawText: normalized,
            transcript: transcript,
            transcriptTruncated: truncated,
            wordCount: wordCount,
            gist: gist,
            title: title
        )
    }
}
