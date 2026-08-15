import SwiftUI

/// The AI summary: executive gist, action items, key decisions.
///
/// Takes the summary rather than the note so it stays trivially previewable
/// and has no reason to reach into the environment.
struct SummaryPane: View {
    /// Scroll anchor for the quick-action row's "Action Items" tile.
    static let actionItemsAnchor = "summary.actionItems"

    let summary: Summary?

    var body: some View {
        if let summary {
            OwllCard {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Executive Summary")
                    Text(summary.gist.isEmpty ? "No summary." : summary.gist)
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !summary.actionItems.isEmpty {
                OwllCard {
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
                OwllCard {
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
