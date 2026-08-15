import Foundation

/// The subtitle under a note's title: `08/12 15:54 · 20.6 KB · 00:03`.
///
/// Every component is optional and the separator collapses around whatever is
/// missing, because the pieces genuinely arrive at different times and from
/// different places:
///
///   - date is always known (Firestore),
///   - duration is client-supplied for recordings and nil for imports until
///     the server probes it,
///   - size is not on the note at all — it comes from Storage metadata, which
///     only the audio player fetches, and notes with no audio never have one.
///
/// Rendering "· ·" around a blank is worse than a shorter line, so absent
/// pieces are dropped rather than placeheld.
enum NoteMeta {
    static func line(createdAt: Date?, durationSeconds: Double?, sizeBytes: Int64?) -> String {
        var parts: [String] = []
        if let createdAt { parts.append(dateText(createdAt)) }
        if let sizeBytes, sizeBytes > 0 { parts.append(sizeText(sizeBytes)) }
        if let durationSeconds, durationSeconds > 0 { parts.append(durationText(durationSeconds)) }
        return parts.joined(separator: " · ")
    }

    /// Matches the Files list so a note reads the same in both places.
    static func dateText(_ date: Date) -> String {
        date.formatted(.dateTime.month(.twoDigits).day(.twoDigits))
            + " "
            + date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute())
    }

    /// `HH:MM:SS` past an hour, `MM:SS` below it — a two-hour meeting
    /// rendered as "120:00" is harder to read than "02:00:00".
    static func durationText(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%02d:%02d", m, s)
    }

    static func sizeText(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
