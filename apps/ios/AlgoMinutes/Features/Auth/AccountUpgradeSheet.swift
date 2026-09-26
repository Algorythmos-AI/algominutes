import AuthenticationServices
import SwiftUI

/// A6.3 guest → permanent account prompt. Presented AFTER the first summary —
/// never at launch — to a still-anonymous guest.
///
/// Both buttons UPGRADE THE ANONYMOUS ACCOUNT IN PLACE (Firebase
/// `linkWithCredential`), so the uid, the workspace, every note, and the
/// reverse-trial clock are preserved. Signing in does not restart the trial or
/// lose data — the copy says so because it is literally true.
struct AccountUpgradeSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    /// Opens the paywall after the account step, if the caller wants it.
    var onSeePlans: () -> Void = {}

    var body: some View {
        VStack(spacing: Theme.Spacing.xl) {
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.heading)
                Text("Save your notes")
                    .font(Typography.title())
                    .foregroundStyle(Theme.heading)
                Text(Self.message(paywallEnabled: AppConfig.paywallEnabled))
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, Theme.Spacing.lg)

            VStack(spacing: Theme.Spacing.md) {
                SignInWithAppleButton(.continue) { request in
                    env.auth.prepareAppleRequest(request)
                } onCompletion: { result in
                    Task { await env.auth.completeAppleLink(result) }
                }
                .signInWithAppleButtonStyle(.white)
                .frame(height: 52)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .disabled(env.auth.isSigningIn)
                .accessibilityLabel("Continue with Apple")

                Button {
                    Task { await env.auth.linkWithGoogle() }
                } label: {
                    HStack {
                        Image(systemName: "g.circle.fill")
                        Text("Continue with Google")
                    }
                    .font(Typography.label(17))
                    .foregroundStyle(Theme.heading)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .fill(Theme.surfaceElevated)
                            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.borderSoft))
                    )
                }
                .disabled(env.auth.isSigningIn)

                if let error = env.auth.authError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.heading)
                        .multilineTextAlignment(.center)
                }
            }

            VStack(spacing: Theme.Spacing.sm) {
                // No plans to see while the paywall is off (no products on sale).
                if AppConfig.paywallEnabled {
                    Button("See Pro plans") {
                        dismiss()
                        onSeePlans()
                    }
                    .font(Typography.body(14).weight(.medium))
                    .foregroundStyle(Theme.body)
                }

                Button("Maybe later") { dismiss() }
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.muted)
            }

            HStack(spacing: Theme.Spacing.lg) {
                Link("Privacy Policy", destination: LegalLinks.privacy)
                Link("Terms of Service", destination: LegalLinks.terms)
            }
            .font(Typography.body(12))
            .foregroundStyle(Theme.tertiary)
        }
        .padding(Theme.Spacing.xl)
        // The upgrade preserved the uid — once no longer anonymous, close.
        .onChange(of: env.auth.isAnonymous) { _, anon in
            if !anon { dismiss() }
        }
    }

    /// The prompt's promise. The trial is only mentioned when there's a paywall
    /// it leads to.
    static func message(paywallEnabled: Bool) -> String {
        let save = "Create a free account so your recordings and summaries are backed up and available on your other devices."
        return paywallEnabled ? save + " Your 7-day trial keeps going — nothing is lost." : save + " Nothing is lost."
    }
}
