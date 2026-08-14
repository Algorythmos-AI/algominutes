import SwiftUI

/// The transcript, or the extracted text for scanned and imported notes.
///
/// `LazyVStack` rather than `VStack`: the mirrored preview is 200 lines but a
/// long meeting is thousands, and none of them should be laid out to show the
/// first screenful.
struct TranscriptPane: View {
    let lines: [TranscriptLine]
    let rawText: String?
    /// Index of the line currently playing, if any.
    var activeIndex: Int?
    /// Seek the player. Nil when there is no audio to seek — the rows then
    /// render as plain text rather than as controls that do nothing.
    var onSeek: ((TimeInterval) -> Void)?
    /// True when only the mirrored preview is on screen because the full
    /// fetch failed. The lines already shown stay — a failed fetch must not
    /// empty the transcript someone was reading.
    var isTruncated: Bool = false
    var onRetry: (() -> Void)?

    var body: some View {
        if !lines.isEmpty {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(lines) { line in
                    TranscriptLineRow(
                        line: line,
                        isActive: line.index == activeIndex,
                        onSeek: onSeek
                    )
                }
                if isTruncated {
                    truncationNotice
                }
            }
        } else if let rawText, !rawText.isEmpty {
            Text(rawText)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            EmptyStateView(icon: "text.quote", message: "No transcript available.")
        }
    }

    private var truncationNotice: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("Showing the first \(lines.count) lines.")
                .font(Typography.body(12))
                .foregroundStyle(Theme.muted)
            if let onRetry {
                Button("Retry", action: onRetry)
                    .font(Typography.label(12))
                    .foregroundStyle(Theme.heading)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, Theme.Spacing.sm)
    }
}

struct TranscriptLineRow: View {
    let line: TranscriptLine
    var isActive: Bool = false
    var onSeek: ((TimeInterval) -> Void)?

    /// Where a tap would jump to. Nil means this line cannot be located in
    /// the audio, and the row is then not tappable at all — better than a tap
    /// that silently seeks to zero.
    private var seekTarget: TimeInterval? {
        onSeek == nil ? nil : TranscriptTime.seekTarget(for: line)
    }

    var body: some View {
        if let seekTarget {
            Button { onSeek?(seekTarget) } label: { content }
                .buttonStyle(.plain)
                .accessibilityHint("Play from \(line.time)")
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Speaker and timestamp are both optional. Diarization is off in
            // production, so most lines carry no label; a chip reading
            // "Speaker" on every row would imply an attribution the data does
            // not support, so the row simply omits it.
            if !line.speaker.isEmpty || !line.time.isEmpty {
                HStack(spacing: 8) {
                    if !line.speaker.isEmpty {
                        Text(line.speaker)
                            .font(Typography.label(12))
                            .foregroundStyle(Theme.heading)
                    }
                    if !line.time.isEmpty {
                        Text(line.time)
                            .font(Typography.body(11))
                            .monospacedDigit()
                            .foregroundStyle(Theme.tertiary)
                    }
                }
            }
            Text(line.text)
                // Monochrome, so the playing line is marked by brightness
                // rather than hue — Theme has no accent colour by design.
                .font(Typography.body(15))
                .foregroundStyle(isActive ? Theme.heading : Theme.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, Theme.Spacing.md)
        .overlay(alignment: .leading) {
            // A rule rather than a fill: at 15pt body text a background block
            // reads as a selection, and this is a playhead.
            Rectangle()
                .fill(isActive ? Theme.outline : Color.clear)
                .frame(width: 2)
        }
        .animation(.easeInOut(duration: 0.2), value: isActive)
        .contentShape(Rectangle())
    }
}
