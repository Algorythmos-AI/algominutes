import SwiftUI

/// Choose a summary template and re-run the summarizer.
///
/// Regenerating replaces the existing summary, so the confirming action says
/// what it does rather than "OK". The manual-edit case is handled a level up,
/// in the view model — the server refuses that overwrite and the user gets an
/// explicit choice before anything is lost.
struct TemplatePickerSheet: View {
    let current: SummaryTemplate
    let isRunning: Bool
    let onRegenerate: (SummaryTemplate) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selection: SummaryTemplate

    init(
        current: SummaryTemplate,
        isRunning: Bool,
        onRegenerate: @escaping (SummaryTemplate) -> Void
    ) {
        self.current = current
        self.isRunning = isRunning
        self.onRegenerate = onRegenerate
        _selection = State(initialValue: current)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            Text("Rewrite summary")
                .font(Typography.heading(18, weight: .bold))
                .foregroundStyle(Theme.heading)
                .frame(maxWidth: .infinity)

            VStack(spacing: Theme.Spacing.md) {
                ForEach(SummaryTemplate.allCases) { template in
                    row(template)
                }
            }

            Text("Replaces the current summary. The transcript is not changed.")
                .font(Typography.body(12))
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                onRegenerate(selection)
                dismiss()
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    if isRunning { ProgressView().controlSize(.small) }
                    Text(isRunning ? "Rewriting…" : "Rewrite summary")
                }
                .font(Typography.label(15))
                .frame(maxWidth: .infinity)
                .padding(Theme.Spacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .fill(Theme.surfaceElevated)
                )
                .foregroundStyle(Theme.heading)
            }
            .buttonStyle(CardButtonStyle())
            .disabled(isRunning)

            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.xxl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
    }

    private func row(_ template: SummaryTemplate) -> some View {
        Button {
            selection = template
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: template.icon)
                    .font(.system(size: 18))
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(template.label)
                        .font(Typography.label(14))
                        .foregroundStyle(Theme.heading)
                    Text(template.blurb)
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                // Selection by checkmark, not colour — Theme is monochrome
                // by design and an accent here would be the only one on screen.
                Image(systemName: selection == template ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(selection == template ? Theme.heading : Theme.tertiary)
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surfaceElevated)
            )
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityAddTraits(selection == template ? [.isSelected] : [])
    }
}
