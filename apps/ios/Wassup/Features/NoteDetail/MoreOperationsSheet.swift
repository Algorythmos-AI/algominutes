import SwiftUI
import UIKit

/// Secondary note actions.
///
/// Only actions that work today. Regenerate-summary arrived with its backend
/// (/api/regenerate-summary) and is here; regenerate-*transcription* still is
/// not, because re-running STT needs the diarization work that ADR 0005
/// re-scoped — a row that does nothing is worse than a row that is missing.
struct MoreOperationsSheet: View {
    let note: Note
    let onRename: () -> Void
    let onCopy: () -> Void
    let onPrint: () -> Void
    let onRegenerate: () -> Void
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
            Text("More Operations")
                .font(Typography.heading(18, weight: .bold))
                .foregroundStyle(Theme.heading)
                .frame(maxWidth: .infinity)

            // A 3-column grid rather than hand-built rows: the fourth tile
            // then sits at one-third width under the first, with no filler.
            // The previous `Color.clear` spacers had no intrinsic size, so
            // they expanded vertically and left a large gap in the sheet.
            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: Theme.Spacing.md),
                    count: 3
                ),
                spacing: Theme.Spacing.md
            ) {
                tile("Rename", icon: "pencil", action: onRename)
                tile("Copy", icon: "doc.on.doc", action: onCopy)
                // Printing needs something to print; a summary-less note
                // would produce an empty sheet of paper.
                tile("Print", icon: "printer", action: onPrint, enabled: note.summary != nil)
                // Rewriting needs a transcript to rewrite from, and the server
                // admits only `ready`/`error` — offering it mid-processing
                // would earn a 409 the user did nothing to deserve.
                tile("Rewrite summary", icon: "arrow.clockwise", action: onRegenerate,
                     enabled: !note.status.isInProgress)
            }

            Button(role: .destructive) {
                dismiss()
                onDelete()
            } label: {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "trash")
                    Text("Delete")
                    Spacer()
                }
                .font(Typography.body(15))
                // Destructive by iconography and confirmation, not colour —
                // Theme has no danger token by design.
                .foregroundStyle(Theme.heading)
                .padding(Theme.Spacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .fill(Theme.surfaceElevated)
                )
            }

            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.xxl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
    }

    private func tile(
        _ label: String, icon: String, action: @escaping () -> Void, enabled: Bool = true
    ) -> some View {
        Button {
            dismiss()
            action()
        } label: {
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .frame(height: 24)
                Text(label)
                    .font(Typography.label(12))
            }
            .foregroundStyle(enabled ? Theme.body : Theme.tertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surfaceElevated)
            )
        }
        .buttonStyle(CardButtonStyle())
        .disabled(!enabled)
    }
}

/// Prints the note's summary PDF through the system print controller.
enum NotePrinter {
    static func print(note: Note, onFailure: @escaping (String) -> Void) {
        Task.detached(priority: .userInitiated) {
            let data = PDFExporter.export(note: note)
            await MainActor.run {
                let info = UIPrintInfo(dictionary: nil)
                info.jobName = note.title
                info.outputType = .general
                let controller = UIPrintInteractionController.shared
                controller.printInfo = info
                controller.printingItem = data
                controller.present(animated: true) { _, _, error in
                    if let error {
                        AppLog.error("print_failed: \(error)")
                        onFailure("Couldn't print this note.")
                    }
                }
            }
        }
    }
}
