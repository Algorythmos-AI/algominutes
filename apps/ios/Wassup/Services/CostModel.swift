import Foundation

/// Parity with `src/lib/costs.ts` — estimated, not billed.
enum CostModel {
    static let sttPerAudioMinute = 0.024
    static let llmInputPer1MTokens = 0.075
    static let llmOutputPer1MTokens = 0.30
    static let embedPer1KTokens = 0.000025
    static let charsPerToken = 4.0

    struct NoteCost {
        var durationMinutes: Double
        var stt: Double
        var llm: Double
        var embedding: Double
        var total: Double { stt + llm + embedding }
    }

    static func estimate(note: Note) -> NoteCost {
        let durationMinutes = (note.duration ?? 0) / 60
        let transcriptChars: Double = {
            if let t = note.transcript, !t.isEmpty {
                return Double(t.reduce(0) { $0 + $1.text.count })
            }
            return Double(note.rawText?.count ?? 0)
        }()
        let summaryChars = Double(summaryLength(note.summary))
        let inputTokens = transcriptChars / charsPerToken
        let outputTokens = summaryChars / charsPerToken
        let stt = durationMinutes * sttPerAudioMinute
        let llm = inputTokens / 1_000_000 * llmInputPer1MTokens
            + outputTokens / 1_000_000 * llmOutputPer1MTokens
        let embedding = inputTokens / 1_000 * embedPer1KTokens
        return NoteCost(durationMinutes: durationMinutes, stt: stt, llm: llm, embedding: embedding)
    }

    private static func summaryLength(_ summary: Summary?) -> Int {
        guard let s = summary else { return 0 }
        return s.gist.count
            + s.actionItems.reduce(0) { $0 + $1.count }
            + s.keyDecisions.reduce(0) { $0 + $1.count }
    }

    static func formatUsd(_ value: Double, decimals: Int = 4) -> String {
        guard value.isFinite else { return "$" + String(format: "%.\(decimals)f", 0.0) }
        return "$" + String(format: "%.\(decimals)f", value)
    }
}
