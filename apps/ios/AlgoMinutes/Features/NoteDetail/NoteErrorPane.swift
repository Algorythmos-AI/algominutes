import SwiftUI

/// Terminal failure state, with the one action that can recover it.
///
/// A7.4: shows a plain-English cause derived from the note's `diagnosticCode`
/// (falling back to the server `errorMessage`) plus which pipeline stage failed,
/// so "Processing failed" is no longer the whole story. The single "Try again"
/// recovery is unchanged — it still routes through `AppEnvironment.retry(note:)`,
/// which re-uploads from disk when the local recording is still held.
///
/// Partial success is handled elsewhere and still holds: when the transcript
/// lands but only the summary fails, the note stays `.ready` (not `.error`), so
/// this pane never shows — `NoteDetailView.readyContent` renders the readable
/// transcript and the regenerate-summary action instead. This pane is reserved
/// for a genuinely terminal failure.
struct NoteErrorPane: View {
    let errorMessage: String?
    let diagnosticCode: String?
    let onRetry: () -> Void

    private var diagnostic: NoteDiagnostic {
        NoteDiagnostic.from(diagnosticCode: diagnosticCode, errorMessage: errorMessage)
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(Theme.heading)
                // Decorative — the "Processing failed" heading below carries the meaning.
                .accessibilityHidden(true)
            Text("Processing failed")
                .font(Typography.heading(18, weight: .bold))
                .foregroundStyle(Theme.heading)

            let diagnostic = diagnostic
            Text(diagnostic.cause)
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let stage = diagnostic.stageDescription {
                Text(stage)
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.tertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Try again", action: onRetry)
                .buttonStyle(PrimaryButtonStyle())
                .frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}
