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
    /// Rename a speaker, from their chip. Nil where names can't change.
    var onRenameSpeaker: ((TranscriptLine) -> Void)?
    /// The line a search result opened at (RELEASE.md rev 11, UX8): marked like the playing line until
    /// something plays.
    var focusIndex: Int?

    /// The scroll anchor of a line, for opening a note at a moment.
    static func anchor(_ index: Int) -> String { "transcript-line-\(index)" }

    /// The line to open at for a moment `ms` into the recording, or nil while it isn't on this iPhone yet.
    /// A long note's mirror is its first 200 lines: a moment past them waits for the rest (`complete`) rather
    /// than settling on line 200.
    static func momentIndex(in lines: [TranscriptLine], atMs ms: Double, complete: Bool) -> Int? {
        guard !lines.isEmpty else { return nil }
        let wanted = max(0, ms) / 1000
        guard let index = TranscriptTime.activeIndex(in: lines, at: wanted) else { return complete ? 0 : nil }
        if index == lines.count - 1, !complete,
           let start = TranscriptTime.seekTarget(for: lines[index]), wanted - start > 60 {
            return nil
        }
        return index
    }

    /// Find in the transcript (RELEASE.md rev 11, UX12): a long meeting is hundreds of lines, and the only
    /// way to a remembered phrase was to scroll for it.
    @State private var find = ""

    /// A short transcript fits on a screen or two; the field would only be clutter there.
    static let findFromLines = 12

    /// The lines whose words or speaker contain `query` (case and accents ignored), in order. All of them for
    /// an empty query.
    static func matching(_ lines: [TranscriptLine], query: String) -> [TranscriptLine] {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return lines }
        return lines.filter { line in
            line.text.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive]) != nil
                || line.speaker.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    /// "3 lines match", "1 line matches", "No lines match": said under the field while a query is typed.
    static func findSummary(matches: Int) -> String {
        switch matches {
        case 0: return "No lines match"
        case 1: return "1 line matches"
        default: return "\(matches) lines match"
        }
    }

    var body: some View {
        if !lines.isEmpty {
            let isFinding = !find.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let shown = Self.matching(lines, query: find)
            LazyVStack(alignment: .leading, spacing: 14) {
                if lines.count >= Self.findFromLines {
                    findField(isFinding: isFinding, matches: shown.count)
                }
                ForEach(shown) { line in
                    TranscriptLineRow(
                        line: line,
                        isActive: line.index == (activeIndex ?? focusIndex),
                        onSeek: onSeek,
                        onRenameSpeaker: onRenameSpeaker
                    )
                    .id(Self.anchor(line.index))
                }
                if isTruncated, !isFinding {
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

    private func findField(isFinding: Bool, matches: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.tertiary)
                    .accessibilityHidden(true)
                TextField("Find in transcript", text: $find)
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)
                if isFinding {
                    Button {
                        find = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.tertiary)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear find")
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surfaceElevated))
            if isFinding {
                // Only the lines on this iPhone are searched: say so while the rest is still loading or failed.
                Text(Self.findSummary(matches: matches) + (isTruncated ? " in the first \(lines.count) lines" : ""))
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.muted)
            }
        }
    }

    private var truncationNotice: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("Showing the first \(lines.count) lines.")
                .font(Typography.body(12))
                .foregroundStyle(Theme.muted)
            if let onRetry {
                Button("Try again", action: onRetry)
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
    var onRenameSpeaker: ((TranscriptLine) -> Void)?

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
            // Speaker and timestamp are both optional. On the diarised long
            // path (ADR 0005) a line carries a real "Speaker N" / renamed name;
            // short fast-path and undiarised lines carry none, and the row then
            // simply omits it rather than implying an attribution the data does
            // not support. A speaker with a tag is a chip: tap it to rename them.
            if !line.speaker.isEmpty || !line.time.isEmpty {
                HStack(spacing: 8) {
                    if !line.speaker.isEmpty {
                        if line.speakerTag != nil, let onRenameSpeaker {
                            Button { onRenameSpeaker(line) } label: {
                                Text(line.speaker)
                                    .font(Typography.label(12))
                                    .foregroundStyle(Theme.heading)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Capsule().strokeBorder(Theme.outline.opacity(0.5), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Rename this speaker")
                        } else {
                            Text(line.speaker)
                                .font(Typography.label(12))
                                .foregroundStyle(Theme.heading)
                        }
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
