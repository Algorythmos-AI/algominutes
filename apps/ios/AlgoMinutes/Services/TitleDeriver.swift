import Foundation

/// Parity with `deriveTitleFromSummary` + placeholder handling in `src/App.tsx`.
enum TitleDeriver {
    static let placeholderPattern = #"^(Session|Import)_\d{4}-\d{2}-\d{2}$"#

    static func isPlaceholder(_ title: String) -> Bool {
        title.range(of: placeholderPattern, options: .regularExpression) != nil
    }

    /// First sentence of the gist, trailing punctuation stripped, capped at 80
    /// chars (cut at last space when that space is past index 40, append "…").
    static func derive(fromGist gist: String?) -> String? {
        guard let gist = gist?.trimmingCharacters(in: .whitespacesAndNewlines), !gist.isEmpty else {
            return nil
        }
        let sentence = splitFirstSentence(gist)
        var title = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = title.unicodeScalars.last, ".!?".unicodeScalars.contains(last) {
            title.removeLast()
        }
        title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        if title.count > 80 {
            let prefix = String(title.prefix(80))
            if let lastSpace = prefix.lastIndex(of: " "),
               prefix.distance(from: prefix.startIndex, to: lastSpace) > 40 {
                title = String(prefix[..<lastSpace]) + "…"
            } else {
                title = prefix + "…"
            }
        }
        return title
    }

    private static func splitFirstSentence(_ text: String) -> String {
        // Equivalent of split(/(?<=[.!?])\s+/) — first component.
        var result = ""
        var previous: Character?
        for ch in text {
            if let prev = previous, ch.isWhitespace, ".!?".contains(prev) {
                break
            }
            result.append(ch)
            previous = ch
        }
        return result
    }
}
