import Foundation

/// Turning a transcript line into a seek target, and finding which line is
/// playing.
enum TranscriptTime {
    /// Parse a displayed timestamp back into seconds.
    ///
    /// Only a fallback. `/api/note` returns a real `startMs` per line and that
    /// is always preferred; this exists for lines that came from the Firestore
    /// mirror, which carries the display string only.
    ///
    /// Returns nil rather than 0 on anything it does not fully understand.
    /// That distinction is the point: a line that cannot be located must
    /// render as *not tappable*, because a tap that silently jumps to the
    /// start of a two-hour recording is worse than a tap that does nothing.
    static func seconds(from display: String) -> TimeInterval? {
        let trimmed = display.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count) else { return nil }

        var values: [Int] = []
        for (offset, part) in parts.enumerated() {
            // The leading unit may be one or two digits ("9:05", "12:30");
            // every unit after it is a zero-padded pair.
            let expectedLength = offset == 0 ? 1...2 : 2...2
            guard expectedLength.contains(part.count),
                  part.allSatisfy(\.isNumber),
                  let value = Int(part)
            else { return nil }
            values.append(value)
        }

        // Reject impossible clock components rather than normalising them —
        // "0:99" is corrupt data, not 99 seconds.
        guard values.dropFirst().allSatisfy({ $0 < 60 }) else { return nil }

        return values.count == 2
            ? TimeInterval(values[0] * 60 + values[1])
            : TimeInterval(values[0] * 3600 + values[1] * 60 + values[2])
    }

    /// Seconds into the audio at which this line begins, preferring the exact
    /// value from the API over the parsed display string.
    static func seekTarget(for line: TranscriptLine) -> TimeInterval? {
        if let ms = line.startMs { return ms / 1000 }
        return seconds(from: line.time)
    }

    /// Index of the line playing at `time`: the last one that has started.
    ///
    /// A forward scan with an early exit rather than a binary search. Lines
    /// are time-ordered but some may have no timestamp at all — a mixed
    /// transcript is real — and a binary search over a partially-comparable
    /// array is where subtle off-by-ones live. The scan stops at the first
    /// line that has not started yet, so the work is proportional to playback
    /// position, which at four ticks a second is nothing a phone notices.
    ///
    /// Returns nil when no line has started, so nothing is highlighted rather
    /// than the wrong thing.
    static func activeIndex(in lines: [TranscriptLine], at time: TimeInterval) -> Int? {
        var found: Int?
        for (index, line) in lines.enumerated() {
            guard let start = seekTarget(for: line) else { continue }
            if start <= time { found = index } else { break }
        }
        return found
    }
}
