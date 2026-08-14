import Foundation

/// Validation for a user-typed note title.
///
/// Kept pure so the rules are testable and identical everywhere a title can
/// be set — the post-recording save sheet and the rename sheet.
enum NoteTitleInput {
    /// Matches `sanitizeNoteEdit` in shared/note-edit.cjs. The server is the
    /// real authority; enforcing the same number here means the field stops
    /// accepting input rather than letting someone type a title that will be
    /// rejected on save.
    static let maxLength = 300

    /// Titles reach a filesystem: PDFExporter derives an export filename from
    /// this, and a path separator there would silently write somewhere
    /// unintended. Control characters are stripped for the same reason a NUL
    /// is stripped from scanned text.
    private static let forbidden = CharacterSet(charactersIn: "/\\:")
        .union(.controlCharacters)

    /// Clean a title as the user types: strip characters that cannot survive a
    /// filename, collapse runs of whitespace, and cap the length.
    ///
    /// Deliberately *not* trimming trailing whitespace here — doing that while
    /// someone is typing eats the space between words. Trimming happens in
    /// `validated(_:)`, at save time.
    static func sanitize(_ raw: String) -> String {
        let stripped = raw.components(separatedBy: forbidden).joined()
        let collapsed = stripped.replacingOccurrences(
            of: "[ \\t]{2,}", with: " ", options: .regularExpression
        )
        return String(collapsed.prefix(maxLength))
    }

    /// The value to save, or nil if there is nothing meaningful to save.
    ///
    /// Nil covers empty, whitespace-only, and unchanged — a rename that is not
    /// a change should not cost a round trip or bump `updatedAt`.
    static func validated(_ raw: String, current: String? = nil) -> String? {
        let cleaned = sanitize(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned != current else { return nil }
        return cleaned
    }
}
