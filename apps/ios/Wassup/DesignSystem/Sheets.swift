import SwiftUI

// Standard sheet chrome.
//
// The same four presentation modifiers were copy-pasted onto every sheet in
// the app, and had already drifted: the delete-account sheet in SettingsView
// carried only two of them, so it presented with square corners and no drag
// indicator while every other sheet was rounded with one. Nobody chose that;
// it is just what happens to a four-line idiom repeated five times.
//
// The note-detail work adds four more sheets (save/rename, title actions,
// more operations, share & export), so the idiom is centralised first.

extension View {
    /// Applies Wassup's sheet chrome: charcoal surface, extra-large corner
    /// radius, visible drag indicator.
    ///
    /// Apply to the sheet's *content*, which is where SwiftUI reads
    /// presentation modifiers from:
    ///
    ///     .sheet(isPresented: $showChat) {
    ///         ChatView(viewModel: chatModel).wassupSheet()
    ///     }
    ///
    /// - Parameter detents: heights the sheet may rest at. Defaults to
    ///   `.large`, which is what most sheets here use.
    func wassupSheet(_ detents: Set<PresentationDetent> = [.large]) -> some View {
        self
            .presentationDetents(detents)
            .presentationBackground(Theme.surface)
            .presentationCornerRadius(Theme.Radius.xl)
            .presentationDragIndicator(.visible)
    }
}
