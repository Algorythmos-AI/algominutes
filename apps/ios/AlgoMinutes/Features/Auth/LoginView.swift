import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Image("Logo")
                .resizable()
                .scaledToFit()
                .frame(height: 120)
                .shadow(color: .white.opacity(0.2), radius: 24)
                .accessibilityHidden(true)

            Text("AlgoMinutes")
                .font(Typography.heading(34, weight: .black))
                .foregroundStyle(Theme.heading)
                .padding(.top, 18)

            Text("Record, transcribe, and get the minutes.")
                .font(Typography.body(15))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 40)

            Spacer()

            VStack(spacing: 12) {
                SignInWithAppleButton(.signIn) { request in
                    env.auth.prepareAppleRequest(request)
                } onCompletion: { result in
                    Task { await env.auth.completeAppleSignIn(result) }
                }
                .signInWithAppleButtonStyle(.white)
                .frame(height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .disabled(env.auth.isSigningIn)
                .accessibilityLabel("Sign in with Apple")

                Button {
                    Task { await env.auth.signInWithGoogle() }
                } label: {
                    HStack {
                        Image(systemName: "g.circle.fill")
                        Text("Sign in with Google")  // TODO(i18n): tokens key auth.signInWithGoogle
                    }
                    // Scalable label (Dynamic Type) — matches SignInWithAppleButton, which scales its own text.
                    .font(Typography.label(17))
                    .foregroundStyle(Theme.heading)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(Theme.surfaceElevated)
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.borderSoft))
                    )
                }
                .disabled(env.auth.isSigningIn)

                if let error = env.auth.authError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.heading)
                        .multilineTextAlignment(.center)
                }

                #if DEBUG
                Button {
                    Task { await env.auth.signInAsDevGuest() }
                } label: {
                    Text("Skip sign-in (dev)")
                        .font(Typography.body(13).weight(.medium))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .disabled(env.auth.isSigningIn)
                #endif
            }
            .padding(.horizontal, 24)

            // A10 #3: signing in creates the account and records timestamped
            // acceptance of these documents (AppEnvironment.recordTermsAcceptanceIfNeeded).
            VStack(spacing: 6) {
                Text("By continuing you agree to our Terms of Service and Privacy Policy.")
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                HStack(spacing: 16) {
                    Link("Privacy Policy", destination: LegalLinks.privacy)
                    Link("Terms of Service", destination: LegalLinks.terms)
                }
            }
            .font(Typography.body(12))
            .foregroundStyle(Theme.tertiary)
            .padding(.top, 24)
            .padding(.bottom, 36)
        }
        .background(AlgoMinutesBackground())
    }
}

enum LegalLinks {
    static let privacy = URL(string: "https://algominutes.com/privacy")!
    static let terms = URL(string: "https://algominutes.com/terms")!
    static let webApp = URL(string: "https://algominutes.com")!
}
