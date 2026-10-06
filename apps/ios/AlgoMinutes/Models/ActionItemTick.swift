import Foundation

/// One action item as the server holds it: an id to tick it by, and whether it is done.
///
/// The Firestore mirror the note is drawn from carries action items as text only, so the
/// ids come from the note read (`POST /v1/notes/read`). An edit of the summary replaces the
/// rows and so the ids: a tick answered 404 means "read again", not "failed".
struct ActionItemTick: Identifiable, Equatable {
    let id: String
    let text: String
    var done: Bool
}

enum ActionItemTicks {
    private struct Response: Decodable {
        struct Summary: Decodable { let actionItems: [Item]? }
        struct Item: Decodable {
            let id: String?
            let text: String
            let status: String?

            private enum CodingKeys: String, CodingKey { case id, text, status }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                // The contract allows a number (rows from before ids were UUIDs); only a string can be ticked.
                id = try? c.decode(String.self, forKey: .id)
                text = try c.decode(String.self, forKey: .text)
                status = try? c.decode(String.self, forKey: .status)
            }
        }
        let summary: Summary?
    }

    /// The items in a note-read answer, in the server's order. Throws on an answer that isn't one.
    static func parse(_ data: Data) throws -> [ActionItemTick] {
        let items = try JSONDecoder().decode(Response.self, from: data).summary?.actionItems ?? []
        return items.compactMap { item in
            guard let id = item.id, !id.isEmpty else { return nil }
            return ActionItemTick(id: id, text: item.text, done: item.status == "done")
        }
    }

    /// The ticks, only when they are the items on screen: the same texts in the same order.
    /// Anything else (not loaded, an item without an id, a summary edited since) shows plain bullets.
    static func matching(_ ticks: [ActionItemTick]?, texts: [String]) -> [ActionItemTick]? {
        guard let ticks, ticks.map(\.text) == texts else { return nil }
        return ticks
    }

    static func setting(_ ticks: [ActionItemTick]?, id: String, done: Bool) -> [ActionItemTick]? {
        ticks?.map { $0.id == id ? ActionItemTick(id: $0.id, text: $0.text, done: done) : $0 }
    }

    /// The server no longer has that item: the summary was edited, and its items have new ids.
    static func isGone(_ error: Error) -> Bool {
        if case APIError.http(status: 404, _) = error { return true }
        return false
    }
}
