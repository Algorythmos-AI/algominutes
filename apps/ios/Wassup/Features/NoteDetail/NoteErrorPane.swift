import SwiftUI

/// Terminal failure state, with the one action that can recover it.
struct NoteErrorPane: View {
    let errorMessage: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(Theme.heading)
            Text("Processing failed")
                .font(Typography.heading(18, weight: .bold))
                .foregroundStyle(Theme.heading)
            Text(errorMessage ?? "We couldn't analyse this recording. Please try again.")
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Try again", action: onRetry)
                .buttonStyle(PrimaryButtonStyle())
                .frame(maxWidth: 220)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}
