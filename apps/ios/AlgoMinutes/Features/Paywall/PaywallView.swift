import StoreKit
import SwiftUI

/// A9.5 paywall. Shows StoreKit pricing ONLY — price, billing period, and
/// renewal terms come straight from the loaded `Product`, plus Terms & Privacy
/// links, a Restore button that works without signing in, and a Manage/Cancel
/// route into the system subscription settings.
///
/// App Review 3.1.3 (checked 2026): there is deliberately NO web-pricing copy,
/// no "cheaper on the web" CTA, and no external purchase link anywhere in this
/// view. Everything transacts through StoreKit.
struct PaywallView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    @State private var selectedProductID: String?
    @State private var purchaseError: String?
    @State private var isPurchasing = false
    /// Ask-to-Buy / deferred: the purchase is awaiting approval, nothing owed.
    @State private var showPendingApproval = false
    @State private var isRestoring = false
    @State private var inGracePeriod = false

    private var store: StoreKitService { env.billing.store }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                    headline
                    if inGracePeriod { gracePeriodNotice }
                    if showPendingApproval { pendingApprovalNotice }
                    productList
                    if let purchaseError { errorRow(purchaseError) }
                    purchaseButton
                    restoreAndManage
                    renewalTerms
                    legalLinks
                }
                .padding(Theme.Spacing.xl)
            }
            .background(AlgoMinutesBackground())
            .navigationTitle("AlgoMinutes Pro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }
                        .foregroundStyle(Theme.muted)
                }
            }
        }
        .task {
            if store.products.isEmpty { await store.loadProducts() }
            selectedProductID = selectedProductID ?? store.products.first?.id
            inGracePeriod = await store.isInGracePeriod()
        }
    }

    // MARK: - Headline

    private var headline: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(contextHeadline)
                .font(Typography.title())
                .foregroundStyle(Theme.heading)
            Text("1,500 minutes a month, and every note searchable and summarised.")
                .font(Typography.body(15))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var contextHeadline: String {
        switch env.billing.paywallContext {
        case .quotaHit:    return "You're out of included minutes"
        case .meteredGate: return "Your free plan is limited"
        case .firstSummary, .manual: return "Go Pro"
        }
    }

    // MARK: - Products (StoreKit pricing only)

    @ViewBuilder
    private var productList: some View {
        if store.products.isEmpty {
            unavailableState
        } else {
            VStack(spacing: Theme.Spacing.md) {
                ForEach(store.products, id: \.id) { product in
                    productRow(product)
                }
            }
        }
    }

    private func productRow(_ product: Product) -> some View {
        let isSelected = selectedProductID == product.id
        return Button {
            selectedProductID = product.id
        } label: {
            HStack(alignment: .center, spacing: Theme.Spacing.md) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(isSelected ? Theme.heading : Theme.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName)
                        .font(Typography.headline())
                        .foregroundStyle(Theme.heading)
                    // Period + intro offer come from StoreKit metadata only.
                    Text(periodDescription(product))
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.muted)
                }
                Spacer()
                // `displayPrice` is the App Store's localized price string — the
                // only price shown, never a hardcoded or web figure.
                Text(product.displayPrice)
                    .font(Typography.headline())
                    .foregroundStyle(Theme.heading)
            }
            .padding(Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surface)
                    .strokeBorder(
                        isSelected ? Theme.heading.opacity(0.5) : Theme.borderSoft,
                        lineWidth: 1
                    )
            )
        }
        .buttonStyle(.plain)
    }

    /// Human-readable billing period from the StoreKit subscription metadata.
    private func periodDescription(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "" }
        let unit: String
        switch period.unit {
        case .day: unit = period.value == 1 ? "day" : "\(period.value) days"
        case .week: unit = period.value == 1 ? "week" : "\(period.value) weeks"
        case .month: unit = period.value == 1 ? "month" : "\(period.value) months"
        case .year: unit = period.value == 1 ? "year" : "\(period.value) years"
        @unknown default: unit = "period"
        }
        return "Billed every \(unit), auto-renews"
    }

    private var unavailableState: some View {
        VStack(spacing: Theme.Spacing.md) {
            if store.isLoadingProducts {
                ProgressView().tint(Theme.heading)
                Text("Loading plans…")
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.muted)
            } else {
                // TODO(A4-apple): products not configured in App Store Connect yet.
                Text("Plans are unavailable right now. Please try again shortly.")
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.xl)
    }

    // MARK: - Purchase

    @ViewBuilder
    private var purchaseButton: some View {
        if !store.products.isEmpty {
            Button {
                Task { await purchase() }
            } label: {
                if isPurchasing {
                    ProgressView().tint(Theme.onInverse)
                } else {
                    Text("Continue")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isPurchasing || selectedProductID == nil)
        }
    }

    private func purchase() async {
        guard let id = selectedProductID,
              let product = store.products.first(where: { $0.id == id }) else { return }
        isPurchasing = true
        purchaseError = nil
        showPendingApproval = false
        defer { isPurchasing = false }

        switch await store.purchase(product) {
        case .success:
            await env.billing.refresh()
            dismiss()
        case .pending:
            // Ask-to-Buy / SCA: keep the sheet, explain the wait.
            showPendingApproval = true
        case .userCancelled:
            break
        case .failed(let message):
            purchaseError = message
        }
    }

    // MARK: - Restore + manage

    private var restoreAndManage: some View {
        VStack(spacing: Theme.Spacing.md) {
            // Restore works WITHOUT a permanent account — see StoreKitService.
            Button {
                Task {
                    isRestoring = true
                    _ = await store.restore()
                    await env.billing.refresh()
                    isRestoring = false
                    if env.billing.entitlement?.state == .active { dismiss() }
                }
            } label: {
                if isRestoring {
                    ProgressView().tint(Theme.body)
                } else {
                    Text("Restore Purchases")
                }
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(isRestoring)

            // Manage / cancel deep-links to the system subscription settings.
            Button("Manage or Cancel Subscription") {
                Task { await store.showManageSubscriptions() }
            }
            .font(Typography.body(13))
            .foregroundStyle(Theme.muted)
        }
    }

    // MARK: - Renewal terms + legal

    private var renewalTerms: some View {
        Text(
            "Your subscription auto-renews at the price shown until you cancel. "
            + "Cancel anytime from Manage Subscription; access continues until the "
            + "end of the current billing period. Payment is charged to your Apple "
            + "Account."
        )
        .font(Typography.body(12))
        .foregroundStyle(Theme.tertiary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var legalLinks: some View {
        HStack(spacing: Theme.Spacing.lg) {
            Link("Terms of Service", destination: LegalLinks.terms)
            Link("Privacy Policy", destination: LegalLinks.privacy)
            Spacer()
        }
        .font(Typography.body(12))
        .foregroundStyle(Theme.muted)
    }

    // MARK: - Notices

    private var gracePeriodNotice: some View {
        noticeBanner(
            icon: "creditcard.trianglebadge.exclamationmark",
            title: "Update your payment method",
            message: "Your subscription is in a grace period. Update payment to keep Pro access."
        )
    }

    private var pendingApprovalNotice: some View {
        noticeBanner(
            icon: "clock.badge.checkmark",
            title: "Waiting for approval",
            message: "This purchase needs approval (Ask to Buy). You'll get Pro as soon as it's approved — nothing is charged yet."
        )
    }

    private func noticeBanner(icon: String, title: String, message: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon).foregroundStyle(Theme.heading)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typography.headline()).foregroundStyle(Theme.heading)
                Text(message)
                    .font(Typography.body(13)).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .fill(Theme.surface)
                .strokeBorder(Theme.outline.opacity(0.25), lineWidth: 1)
        )
    }

    private func errorRow(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(Typography.body(13))
            .foregroundStyle(Theme.heading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A9.4/A9.3 trial countdown banner. Shows only while the server says the user
/// is `trialing`; tapping opens the paywall. Reads the countdown from
/// `entitlement.trialEndsAt` — never a locally-computed trial clock.
struct TrialBanner: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        // Only with a paywall to open: without one, the banner's tap goes nowhere.
        if AppConfig.paywallEnabled, env.billing.isTrialing, let days = env.billing.trialDaysRemaining {
            Button {
                env.billing.presentPaywall(.manual)
            } label: {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "sparkles").foregroundStyle(Theme.heading)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(days <= 0
                             ? "Your trial ends today"
                             : "\(days) day\(days == 1 ? "" : "s") left in your trial")
                            .font(Typography.headline())
                            .foregroundStyle(Theme.heading)
                        Text("Tap to see Pro plans")
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
                }
                .padding(Theme.Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .fill(Theme.surface)
                        .strokeBorder(Theme.outline.opacity(0.25), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
    }
}
