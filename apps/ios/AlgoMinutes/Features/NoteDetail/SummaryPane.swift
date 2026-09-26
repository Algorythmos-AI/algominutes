import SwiftUI

/// The AI summary: executive gist, action items, key decisions.
///
/// Takes the summary rather than the note so it stays trivially previewable
/// and has no reason to reach into the environment.
struct SummaryPane: View {
    /// Scroll anchor for the quick-action row's "Action Items" tile.
    static let actionItemsAnchor = "summary.actionItems"

    let summary: Summary?
    /// Plays from a chapter's start; nil when the note has no playable audio.
    var onSeek: ((TimeInterval) -> Void)? = nil

    var body: some View {
        if let summary {
            AlgoMinutesCard {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Executive Summary")
                    Text(summary.gist.isEmpty ? "No summary." : summary.gist)
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !summary.chapters.isEmpty {
                ChaptersCard(chapters: summary.chapters, onSeek: onSeek)
            }
            if !summary.actionItems.isEmpty {
                AlgoMinutesCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel("Action Items")
                        ForEach(summary.actionItems, id: \.self) { item in
                            BulletRow(item, icon: "checkmark.circle")
                        }
                    }
                }
                .id(Self.actionItemsAnchor)
            }
            if !summary.keyDecisions.isEmpty {
                AlgoMinutesCard {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel("Key Decisions")
                        ForEach(summary.keyDecisions, id: \.self) { decision in
                            BulletRow(decision, icon: "flag")
                        }
                    }
                }
            }
        } else {
            EmptyStateView(icon: "text.alignleft", message: "No summary available.")
        }
    }
}

/// Uppercased card eyebrow. Scoped to note detail on purpose: the app has two
/// other section-label styles (Typography.eyebrow() in Files, Home and
/// Settings) and unifying them is a restyle decision, not a rename.
struct SectionLabel: View {
    private let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(Typography.label(11))
            .kerning(1.2)
            .foregroundStyle(Theme.muted)
    }
}

struct BulletRow: View {
    private let text: String
    private let icon: String

    init(_ text: String, icon: String) {
        self.text = text
        self.icon = icon
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(Theme.outline)
                .padding(.top, 2)
            Text(text)
                .font(Typography.body(14))
                .foregroundStyle(Theme.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A long recording's sections, in order. With audio, a tap plays from there.
private struct ChaptersCard: View {
    let chapters: [SummaryChapter]
    let onSeek: ((TimeInterval) -> Void)?

    var body: some View {
        AlgoMinutesCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel("Chapters")
                ForEach(chapters) { chapter in
                    if let onSeek {
                        Button { onSeek(TimeInterval(chapter.startMs) / 1000) } label: { row(chapter) }
                            .buttonStyle(.plain)
                            .accessibilityHint("Plays the recording from here")
                    } else {
                        row(chapter)
                    }
                }
            }
        }
    }

    private func row(_ chapter: SummaryChapter) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            Text(chapter.clock)
                .font(Typography.label(13).monospacedDigit())
                .foregroundStyle(Theme.muted)
            VStack(alignment: .leading, spacing: 2) {
                Text(chapter.title)
                    .font(Typography.label(15))
                    .foregroundStyle(Theme.heading)
                if !chapter.summary.isEmpty {
                    Text(chapter.summary)
                        .font(Typography.body(14))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
