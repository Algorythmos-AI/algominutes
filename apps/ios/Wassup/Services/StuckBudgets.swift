import Foundation

/// Parity with the stuck-note watchdog budgets in `src/App.tsx`.
enum StuckBudgets {
    static let checkInterval: TimeInterval = 60

    /// Millisecond budgets per status; statuses not listed are never "stuck".
    static let budgetsMs: [NoteStatus: Double] = [
        .processing: 90_000,
        .queued: 90_000,
        .chunking: 300_000,
        .transcribing: 480_000,
        .summarizing: 240_000,
    ]

    /// Effective budget in ms. Transcribing scales with audio length:
    /// max(8 min, duration × 3 real-time).
    static func effectiveBudgetMs(status: NoteStatus, durationSeconds: Double?) -> Double? {
        guard let base = budgetsMs[status] else { return nil }
        if status == .transcribing, let duration = durationSeconds, duration > 0 {
            return max(base, duration * 1000 * 3)
        }
        return base
    }

    /// True when the note has exceeded its budget, measured from
    /// `lastProgressAt ?? updatedAt`.
    static func isStuck(note: Note, now: Date = Date()) -> Bool {
        guard let budget = effectiveBudgetMs(status: note.status, durationSeconds: note.duration) else {
            return false
        }
        guard let reference = note.lastProgressAtDate ?? note.updatedAtDate else { return false }
        let ageMs = now.timeIntervalSince(reference) * 1000
        return ageMs > budget
    }
}
