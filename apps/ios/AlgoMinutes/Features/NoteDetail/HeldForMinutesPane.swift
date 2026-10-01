import SwiftUI

/// A recording longer than the minutes left this month (RELEASE.md rev 11, H6):
/// it's kept and nothing was charged, and the server processes it on its own
/// once minutes arrive (an invite code, a purchase, or next month's minutes).
/// Nothing to retry, so no button: the note moves on by itself.
struct HeldForMinutesPane: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "hourglass")
                .font(.system(size: 40))
                .foregroundStyle(Theme.heading)
                // Decorative: the heading below carries the meaning.
                .accessibilityHidden(true)
            Text("Waiting for minutes")
                .font(Typography.heading(18, weight: .bold))
                .foregroundStyle(Theme.heading)
            Text("This recording is longer than the minutes you have left this month. It's saved, and nothing was charged.")
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("It's processed on its own once you have minutes: add an invite code in Settings, or it runs when your minutes renew next month.")
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
