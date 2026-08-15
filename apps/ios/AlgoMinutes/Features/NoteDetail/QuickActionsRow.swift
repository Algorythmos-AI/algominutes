import SwiftUI

/// The four things people actually do with a finished note.
///
/// Meeting-native by choice: ADR 0004 rejected Owl's Flashcard and AI Coach
/// tiles as a poor fit for a product. Every tile here has a real
/// destination — none is a placeholder.
///
/// "Follow-up draft" deliberately reuses the note-scoped chat rather than
/// adding an endpoint. It is a fixed prompt against retrieval that is already
/// scoped to this note, so it costs nothing new on the server.
struct QuickActionsRow: View {
    let hasActionItems: Bool
    let canDraft: Bool
    let onActionItems: () -> Void
    let onFollowUp: () -> Void
    let onShare: () -> Void
    let onMore: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes four tiles cannot share a row without the
        // labels truncating to nothing, so they wrap into two — following the
        // HomeView.chipsRow precedent rather than inventing a second pattern.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.md) { tiles }
            VStack(spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.md) { actionItemsTile; followUpTile }
                HStack(spacing: Theme.Spacing.md) { shareTile; moreTile }
            }
        }
    }

    @ViewBuilder private var tiles: some View {
        actionItemsTile
        followUpTile
        shareTile
        moreTile
    }

    // A note with no action items has nowhere to jump to, so the tile is
    // present but unavailable rather than scrolling to an empty section.
    private var actionItemsTile: some View {
        IconTile("Action Items", icon: "checkmark.circle",
                 enabled: hasActionItems, action: onActionItems)
    }

    // Drafting needs a transcript to draft from.
    private var followUpTile: some View {
        IconTile("Follow-up", icon: "envelope", enabled: canDraft, action: onFollowUp)
    }

    private var shareTile: some View {
        IconTile("Share", icon: "square.and.arrow.up", action: onShare)
    }

    private var moreTile: some View {
        IconTile("More", icon: "ellipsis", action: onMore)
    }
}
