import Foundation

/// Playback rates offered by the note player.
///
/// Ordered so tapping the pill walks *up* first — the common intent when
/// reviewing a meeting is "get through this faster" — and wraps past 2× to
/// the one slower option, which is what you reach for to catch a word.
enum PlaybackSpeed: Double, CaseIterable, Sendable {
    case slow = 0.75
    case normal = 1.0
    case fast = 1.25
    case faster = 1.5
    case veryFast = 1.75
    case double = 2.0

    /// Tap order: 1 → 1.25 → 1.5 → 1.75 → 2 → 0.75 → 1 …
    private static let cycle: [PlaybackSpeed] = [.normal, .fast, .faster, .veryFast, .double, .slow]

    func next() -> PlaybackSpeed {
        let order = Self.cycle
        guard let i = order.firstIndex(of: self) else { return .normal }
        return order[(i + 1) % order.count]
    }

    /// "1x", "1.25x" — trailing zeros dropped so the pill stays narrow at
    /// every step and does not reflow the transport row.
    var label: String {
        let value = rawValue
        if value == value.rounded() {
            return "\(Int(value))x"
        }
        return String(format: "%.2f", value)
            .replacingOccurrences(of: "0$", with: "", options: .regularExpression)
            + "x"
    }
}
