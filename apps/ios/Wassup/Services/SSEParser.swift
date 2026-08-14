import Foundation

/// Events emitted by the `/api/chat` stream.
enum ChatStreamEvent: Equatable, Sendable {
    case citations([SearchHit])
    case textDelta(String)
    case done
    case serverError(String)
}

/// Incremental Server-Sent-Events parser. Frames are separated by a blank
/// line; each frame carries optional `event:` and one or more `data:` lines.
/// Parity with the manual reader in `src/components/ChatTab.tsx`.
struct SSEParser {
    private var buffer = ""

    /// Feed a chunk of the byte stream; returns any completed events.
    mutating func feed(_ chunk: String) -> [ChatStreamEvent] {
        buffer += chunk
        var events: [ChatStreamEvent] = []
        while let range = buffer.range(of: "\n\n") {
            let frame = String(buffer[..<range.lowerBound])
            buffer.removeSubrange(..<range.upperBound)
            if let event = Self.parseFrame(frame) {
                events.append(event)
            }
        }
        return events
    }

    static func parseFrame(_ frame: String) -> ChatStreamEvent? {
        var eventName: String?
        var dataLines: [String] = []
        for line in frame.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces))
            }
        }
        let dataString = dataLines.joined(separator: "\n")
        guard !dataString.isEmpty || eventName != nil else { return nil }
        let json = dataString.data(using: .utf8).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }

        switch eventName {
        case "citations":
            guard let hitsRaw = json?["hits"],
                  let hitsData = try? JSONSerialization.data(withJSONObject: hitsRaw),
                  let hits = try? JSONDecoder().decode([SearchHit].self, from: hitsData) else {
                return .citations([])
            }
            return .citations(hits)
        case "done":
            return .done
        case "error":
            return .serverError(json?["error"] as? String ?? "stream_failed")
        default:
            if let text = json?["text"] as? String {
                return .textDelta(text)
            }
            return nil
        }
    }
}
