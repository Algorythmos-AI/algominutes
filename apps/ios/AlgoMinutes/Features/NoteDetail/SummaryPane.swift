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
    /// The action items as the server holds them; nil until read, and then they show as plain bullets.
    var ticks: [ActionItemTick]? = nil
    var onTick: ((ActionItemTick, Bool) -> Void)? = nil

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
                        if let onTick, let ticks = ActionItemTicks.matching(ticks, texts: summary.actionItems) {
                            ForEach(ticks) { tick in
                                TickRow(tick: tick) { onTick(tick, !tick.done) }
                            }
                        } else {
                            ForEach(summary.actionItems, id: \.self) { item in
                                BulletRow(item, icon: "checkmark.circle")
                            }
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

/// One action item that can be ticked. The whole row is the button, so the target is the row's height.
private struct TickRow: View {
    let tick: ActionItemTick
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: tick.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(tick.done ? Theme.accent : Theme.outline)
                Text(tick.text)
                    .font(Typography.body(14))
                    .foregroundStyle(tick.done ? Theme.muted : Theme.body)
                    .strikethrough(tick.done)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tick.text)
        .accessibilityValue(tick.done ? "Done" : "Not done")
        .accessibilityHint(tick.done ? "Marks it not done" : "Marks it done")
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
