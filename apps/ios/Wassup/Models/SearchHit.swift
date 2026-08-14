import Foundation

/// One retrieval hit from `/api/search` (also used as a chat citation).
struct SearchHit: Codable, Equatable, Sendable, Identifiable {
    var noteId: String
    var noteTitle: String?
    var chunkText: String
    var startMs: Double
    var endMs: Double
    var score: Double?
    var source: String?

    var id: String { "\(noteId)-\(Int(startMs))-\(chunkText.prefix(24))" }
}

struct SearchResponse: Codable, Sendable {
    var hits: [SearchHit]
}

struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable { case user, assistant }
    var id: String = UUID().uuidString
    var role: Role
    var content: String
    var citations: [SearchHit]?
}

/// Format milliseconds as `MM:SS` — parity with the web `fmtTime`.
func formatTimestamp(ms: Double) -> String {
    let totalSeconds = Int(ms / 1000)
    return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
}

/// Format a recording timer as `MM:SS` — parity with the web `fmt`.
func formatTimer(seconds: Int) -> String {
    String(format: "%02d:%02d", seconds / 60, seconds % 60)
}
