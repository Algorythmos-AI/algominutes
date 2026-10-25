import SwiftUI

/// A recording longer than the minutes left this month (RELEASE.md rev 11, H6):
/// it's kept and nothing was charged, and the server processes it on its own
/// once minutes arrive (an invite code in the beta, a purchase, or next month's
/// minutes). Nothing to retry: the note moves on by itself. With the paywall on,
/// Go Pro is the one button (plan rev 12, Stage 3, I2).
struct HeldForMinutesPane: View {
    @Environment(AppEnvironment.self) private var env

    /// Where this build's minutes come from: the beta's invite code, or Pro.
    static func nextStep(inviteCodes: Bool) -> String {
        inviteCodes
            ? "It's processed on its own once you have minutes: add an invite code in Settings, or it runs when your minutes renew next month."
            : "It's processed on its own once you have minutes: Go Pro, or it runs when your minutes renew next month."
    }

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
            Text(Self.nextStep(inviteCodes: AppConfig.inviteCodesEnabled))
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if AppConfig.paywallEnabled, env.billing.entitlement?.isSubscription != true {
                Button("Go Pro") { env.billing.presentPaywall(.quotaHit) }
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
