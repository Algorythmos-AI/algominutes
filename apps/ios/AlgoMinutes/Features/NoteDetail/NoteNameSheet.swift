import SwiftUI

/// Name or rename a note.
///
/// One sheet for both jobs — the post-recording save and the rename from the
/// note screen — because the rules are the same and two copies would drift.
struct NoteNameSheet: View {
    let title: String
    let prompt: String
    let initialName: String
    /// Existing name, so an unchanged value can be treated as "nothing to do".
    var currentName: String?
    let confirmLabel: String
    /// Returns true if the sheet should close. A failed save keeps it open so
    /// the typed name is not lost.
    let onConfirm: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""
    @State private var isSaving = false
    @FocusState private var focused: Bool

    private var trimmed: String? { NoteTitleInput.validated(name, current: currentName) }

    var body: some View {
        VStack(spacing: Theme.Spacing.xl) {
            VStack(spacing: Theme.Spacing.sm) {
                Text(title)
                    .font(Typography.heading(20, weight: .bold))
                    .foregroundStyle(Theme.heading)
                Text(prompt)
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: Theme.Spacing.sm) {
                TextField("", text: $name)
                    .font(Typography.body(16))
                    .foregroundStyle(Theme.heading)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { save() }
                    // Sanitise as they type so forbidden characters never
                    // appear, rather than rejecting the whole name on save.
                    .onChange(of: name) { _, new in
                        let clean = NoteTitleInput.sanitize(new)
                        if clean != new { name = clean }
                    }
                if !name.isEmpty {
                    Button {
                        name = ""
                        focused = true
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.tertiary)
                            // 44pt hit target (tokens a11y.minTouchTargetPx) — the glyph alone is ~17pt.
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Clear name")
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surfaceElevated)
            )

            Button {
                save()
            } label: {
                if isSaving {
                    ProgressView().tint(Theme.onInverse)
                } else {
                    Text(confirmLabel)
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(trimmed == nil || isSaving)

            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.xxl)
        .frame(maxWidth: .infinity, alignment: .top)
        .background(Theme.surface)
        .onAppear {
            name = NoteTitleInput.sanitize(initialName)
            focused = true
        }
    }

    private func save() {
        guard let value = trimmed, !isSaving else { return }
        isSaving = true
        Task {
            let ok = await onConfirm(value)
            isSaving = false
            if ok { dismiss() }
        }
    }
}
