import SwiftUI

/// Shown while the notes listener is failing and retrying (NotesRepository
/// `listenerHealthy`; RELEASE.md PR 10c). The notes on screen may be out of
/// date, and nothing said so: a failed listener just went quiet.
struct NotesSyncBanner: View {
    @Environment(AppEnvironment.self) private var env

    static let message = "Reconnecting to your notes…"
    static let detail = "What you see may be out of date."

    var body: some View {
        if !env.notes.listenerHealthy {
            HStack(spacing: Theme.Spacing.md) {
                ProgressView().tint(Theme.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.message)
                        .font(Typography.headline())
                        .foregroundStyle(Theme.heading)
                    Text(Self.detail)
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("Try again") { Task { await env.notes.refresh() } }
                    .font(Typography.label(14))
                    .foregroundStyle(Theme.body)
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surface)
                    .strokeBorder(Theme.outline.opacity(0.25), lineWidth: 1)
            )
            .accessibilityElement(children: .combine)
        }
    }
}
