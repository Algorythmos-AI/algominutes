import Foundation

/// Where a text note's text came from (the contract's `TextNoteSource`); it names the note's lines.
enum TextNoteSource: String {
    case scannedImage = "scanned_image"
    case pdf
    case imported
}

/// A text note waiting to be saved. The sheet keeps it while a save fails, so Try again sends the same note: the
/// server answers a note it already saved as ready, rather than making a second one.
struct PendingTextNote: Equatable {
    var noteId: String
    let workspaceId: String
    let text: String
    let source: TextNoteSource
    /// The app's fallback (a file's name); the server prefers the text's own first line.
    let title: String?

    init(workspaceId: String, text: String, source: TextNoteSource, title: String?, noteId: String = PendingTextNote.newId()) {
        self.noteId = noteId
        self.workspaceId = workspaceId
        self.text = text
        self.source = source
        self.title = title
    }

    /// The client's id, as for a recording (the server accepts `[A-Za-z0-9_-]`, up to 128).
    static func newId() -> String { UUID().uuidString.lowercased() }
}

/// A scan, a PDF or an imported file, saved by the server (POST /v1/notes/text; plan rev 12 R12.8, S16): Postgres
/// first, then the doc the note list reads, so it is inside retention, backups, search and export like every other
/// note. The server builds the note (lines, gist, title) from the text, one builder for every client.
enum TextNoteSave {
    /// What the server keeps (characters, as Swift counts them); past it the note is marked truncated.
    static let serverMaxChars = 180_000
    /// The contract's caps, in UTF-16 units (JavaScript string length).
    static let requestMaxUnits = 300_000
    static let titleMaxUnits = 300

    enum Outcome: Equatable {
        case saved(noteId: String)
        /// The message to show, and the note Try again sends.
        case failed(message: String, retry: PendingTextNote)
    }

    static func save(_ note: PendingTextNote, api: APIClient) async -> Outcome {
        do {
            let saved = try await api.createTextNote(
                noteId: note.noteId,
                workspaceId: note.workspaceId,
                text: requestText(note.text),
                source: note.source,
                title: requestTitle(note.title)
            )
            return .saved(noteId: saved.noteId)
        } catch APIError.http(let status, _) where status == 404 || status == 409 {
            // That id was deleted, or is another note's: Try again saves the text under a new one.
            var retry = note
            retry.noteId = PendingTextNote.newId()
            return .failed(message: "Could not save the scan. Please try again.", retry: retry)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Could not save the scan. Please try again."
            return .failed(message: message, retry: note)
        }
    }

    /// The text as sent: one character past what the server keeps (so it still marks the note truncated), and
    /// never past the contract's cap, cut at a character boundary.
    static func requestText(_ text: String) -> String {
        prefix(text, maxChars: serverMaxChars + 1, maxUnits: requestMaxUnits)
    }

    static func requestTitle(_ title: String?) -> String? {
        guard let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return prefix(trimmed, maxChars: Int.max, maxUnits: titleMaxUnits)
    }

    private static func prefix(_ s: String, maxChars: Int, maxUnits: Int) -> String {
        var units = 0
        var chars = 0
        var end = s.startIndex
        for c in s {
            let n = c.utf16.count
            if chars == maxChars || units + n > maxUnits { return String(s[..<end]) }
            units += n
            chars += 1
            end = s.index(after: end)
        }
        return s
    }
}
