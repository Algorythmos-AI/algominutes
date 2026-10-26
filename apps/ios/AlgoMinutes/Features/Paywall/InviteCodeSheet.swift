import SwiftUI

/// The beta's way to recording minutes (docs/plans/RELEASE.md PR 8): the code
/// from the tester's invitation, `BETA-XXXXX-XXXXX-XXXXX`. The server ignores
/// case, spaces and dashes, so a pasted or typed code works either way.
///
/// Opened by `BillingService` with the paywall off: on a quota hit, before a
/// recording when there are no minutes left, and from Settings.
struct InviteCodeSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var isRedeeming = false
    @State private var errorMessage: String?
    @State private var redeemed: RedeemInviteResponse?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: Theme.Spacing.xl) {
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: redeemed == nil ? "ticket.fill" : "checkmark.seal.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.heading)
                Text(redeemed == nil ? "Enter your invite code" : "You're all set")
                    .font(Typography.title())
                    .foregroundStyle(Theme.heading)
                Text(redeemed.map { Self.successLine($0) } ?? Self.explainer)
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, Theme.Spacing.lg)

            if redeemed == nil {
                VStack(spacing: Theme.Spacing.md) {
                    TextField("BETA-XXXXX-XXXXX-XXXXX", text: $code)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                        .submitLabel(.go)
                        .focused($fieldFocused)
                        .onSubmit { redeem() }
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, 14)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.md)
                                .fill(Theme.surfaceElevated)
                                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.borderSoft))
                        )
                        .accessibilityLabel("Invite code")

                    Button(action: redeem) {
                        HStack(spacing: Theme.Spacing.sm) {
                            if isRedeeming { ProgressView().tint(Theme.onInverse) }
                            Text("Add minutes")
                        }
                        .font(Typography.label(17))
                        .foregroundStyle(Theme.onInverse)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.inverse))
                    }
                    .disabled(isRedeeming || Self.trimmed(code).isEmpty)

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(Typography.body(13))
                            .foregroundStyle(Theme.heading)
                            .multilineTextAlignment(.center)
                    }
                }

                Button("Not now") { dismiss() }
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.muted)
            } else {
                Button("Done") { dismiss() }
                    .font(Typography.label(17))
                    .foregroundStyle(Theme.onInverse)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 15)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.inverse))
            }
        }
        .padding(Theme.Spacing.xl)
        .onAppear { fieldFocused = true }
    }

    private func redeem() {
        let entered = Self.trimmed(code)
        guard !entered.isEmpty, !isRedeeming else { return }
        isRedeeming = true
        errorMessage = nil
        Task {
            do {
                redeemed = try await env.billing.redeemInvite(entered)
            } catch {
                errorMessage = Self.message(for: error)
            }
            isRedeeming = false
        }
    }

    // MARK: - Words (static, so they're unit-tested)

    static let explainer = "Your invitation has a code like BETA-XXXXX-XXXXX-XXXXX. It adds recording minutes to this account."

    static func trimmed(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What to tell the tester when a code is refused. The server's codes are in
    /// `APIClient.redeemInvite`.
    static func message(for error: Error) -> String {
        if case APIError.http(let status, let code) = error {
            switch code {
            case "invite_invalid":
                return "That code isn't valid. Check it against your invitation and try again."
            case "invite_expired":
                return "That code has expired. Ask whoever invited you for a new one."
            case "invite_used_up":
                return "That code has been used as many times as it allows. Ask whoever invited you for a new one."
            case "rate_limited":
                return "Too many tries. Wait a few minutes, then try again."
            default:
                if status >= 500 { return "Something went wrong on our side. Please try again in a minute." }
            }
        }
        if error is URLError { return "No connection. Check your internet, then try again." }
        return "We couldn't add that code. Please try again."
    }

    /// What the code gave: the minutes left now, and until when.
    static func successLine(_ result: RedeemInviteResponse, locale: Locale = .current) -> String {
        let minutes = result.entitlement.remainingMinutes.map { Int($0.rounded()).formatted(.number.locale(locale)) }
        let what = minutes.map { "You have \($0) recording minutes" } ?? "Recording is on"
        guard let iso = result.grantEndsAt, let end = Self.parseISO(iso) else {
            return "\(what) for this beta. Anything that couldn't process can be tried again now."
        }
        let day = end.formatted(Date.FormatStyle(locale: locale).day().month(.wide))
        return "\(what), until \(day). Anything that couldn't process can be tried again now."
    }

    private static func parseISO(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
