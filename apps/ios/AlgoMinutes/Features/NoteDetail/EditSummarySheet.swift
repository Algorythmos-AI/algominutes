import SwiftUI

/// Edit a note's summary by hand (RELEASE.md rev 11, UX12), as the web's "Edit summary" does: the summary,
/// then the action items and the key decisions, one per line. Saved through the api, so search and chat see it.
struct EditSummarySheet: View {
    let summary: Summary
    /// Saves the edit; true when it was saved (the sheet then closes).
    let onSave: (Summary) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var gist: String
    @State private var actions: String
    @State private var decisions: String
    @State private var isSaving = false

    init(summary: Summary, onSave: @escaping (Summary) async -> Bool) {
        self.summary = summary
        self.onSave = onSave
        _gist = State(initialValue: summary.gist)
        _actions = State(initialValue: summary.actionItems.joined(separator: "\n"))
        _decisions = State(initialValue: summary.keyDecisions.joined(separator: "\n"))
    }

    /// The server's own limit on a summary's text.
    static let maxGistCharacters = 20_000

    /// One item per line, trimmed, with the empty lines left out.
    static func lines(_ text: String) -> [String] {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// The summary as edited, or nil when there's nothing to save: an empty summary, or no change at all.
    /// Whatever the form doesn't show (key points, chapters) is carried over untouched.
    static func edited(_ original: Summary, gist: String, actions: String, decisions: String) -> Summary? {
        let trimmed = String(gist.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxGistCharacters))
        guard !trimmed.isEmpty else { return nil }
        var next = original
        next.gist = trimmed
        next.actionItems = lines(actions)
        next.keyDecisions = lines(decisions)
        return next == original ? nil : next
    }

    private var edit: Summary? { Self.edited(summary, gist: gist, actions: actions, decisions: decisions) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    Text("Edit summary")
                        .font(Typography.heading(20, weight: .bold))
                        .foregroundStyle(Theme.heading)
                    field("Summary", text: $gist, minHeight: 160)
                    field("Action items, one per line", text: $actions, minHeight: 110)
                    field("Key decisions, one per line", text: $decisions, minHeight: 110)
                    Text("Rewriting the summary later replaces what you type here, and asks first.")
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Theme.Spacing.xxl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            VStack(spacing: 10) {
                Button(isSaving ? "Saving…" : "Save") {
                    guard let edit, !isSaving else { return }
                    isSaving = true
                    Task {
                        let saved = await onSave(edit)
                        isSaving = false
                        if saved { dismiss() }
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(edit == nil || isSaving)
                .opacity(edit == nil || isSaving ? 0.5 : 1)
                Button("Cancel") { dismiss() }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(isSaving)
            }
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .background(Theme.surface)
        .interactiveDismissDisabled(isSaving)
    }

    private func field(_ label: String, text: Binding<String>, minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(label.uppercased())
                .font(Typography.label(11))
                .kerning(1.2)
                .foregroundStyle(Theme.muted)
            TextEditor(text: text)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .scrollContentBackground(.hidden)
                .padding(Theme.Spacing.sm)
                .frame(minHeight: minHeight)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surfaceElevated))
                .accessibilityLabel(label)
        }
    }
}
