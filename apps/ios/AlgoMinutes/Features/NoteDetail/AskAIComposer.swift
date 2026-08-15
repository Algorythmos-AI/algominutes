import SwiftUI

/// Ask a question about *this* meeting.
///
/// Retrieval is scoped server-side to the open note, so answers cannot drift
/// into other meetings — which is the difference between this and the
/// workspace-wide chat in the Files tab.
struct AskAIComposer: View {
    @Bindable var model: ChatViewModel
    let onOpenConversation: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // The most recent answer, inline. The full conversation lives in
            // the sheet; showing every turn here would push the transcript
            // off the screen the user came for.
            if let latest = model.messages.last, latest.role == .assistant, !latest.content.isEmpty {
                Button(action: onOpenConversation) {
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        Text(latest.content)
                            .font(Typography.body(14))
                            .foregroundStyle(Theme.body)
                            .lineLimit(4)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.tertiary)
                            .padding(.top, 3)
                    }
                    .padding(Theme.Spacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated)
                    )
                }
                .buttonStyle(CardButtonStyle())
                .padding(.bottom, Theme.Spacing.sm)
            }

            HStack(spacing: Theme.Spacing.sm) {
                TextField("Ask about this meeting…", text: $model.draft, axis: .vertical)
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.heading)
                    .lineLimit(1...4)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(model.isStreaming)

                Button(action: send) {
                    if model.isStreaming {
                        ProgressView().tint(Theme.onInverse)
                            .frame(width: 30, height: 30)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Theme.onInverse)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Theme.inverse))
                    }
                }
                .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || model.isStreaming)
                // 44pt hit target (tokens a11y.minTouchTargetPx) — the visible disc is 30pt.
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityLabel("Ask")
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .stroke(Theme.border, lineWidth: 1)
                    )
            )
        }
    }

    private func send() {
        guard !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        focused = false
        model.send()
    }
}
