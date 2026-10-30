import Foundation
import StoreKit
import UIKit

/// StoreKit 2 wrapper (A9.4). Loads products, runs purchases, listens for
/// out-of-band transaction updates, and — critically — forwards every verified
/// transaction's signed JWS to the server for validation. The SERVER grants the
/// entitlement; this client never sets an "I'm Pro" flag of its own.
///
/// App Review note (3.1.3, checked 2026): everything user-facing here uses
/// StoreKit pricing only. There is no web-pricing path in this file.
@Observable
@MainActor
final class StoreKitService {
    /// Loaded StoreKit products, in a stable display order (monthly, annual).
    private(set) var products: [Product] = []
    private(set) var isLoadingProducts = false
    /// Set true once `loadProducts()` has run, so the paywall can distinguish
    /// "still loading" from "App Store Connect has no products yet".
    private(set) var didAttemptLoad = false
    private(set) var lastError: String?

    /// Outcome of a `purchase(_:)` call, including the async Ask-to-Buy path.
    enum PurchaseOutcome: Equatable {
        /// Billing accepted the receipt: Pro is on.
        case success
        /// StoreKit deferred the purchase — Ask-to-Buy / SCA / parental approval.
        /// Nothing is owed yet; the transaction arrives later via the updates
        /// listener. The paywall shows a "waiting for approval" state.
        case pending
        case userCancelled
        /// StoreKit took the payment but billing refused the receipt, or StoreKit failed; says why.
        case failed(String)
        /// StoreKit took the payment but billing couldn't be reached. The transaction stays unfinished and is
        /// sent again (`confirmationDelayedMessage`).
        case confirmationDelayed
    }

    private let api: any PurchaseVerifying

    /// Called after any verified transaction is forwarded to the server, so the
    /// billing layer can re-read the authoritative entitlement. Set by
    /// `BillingService`.
    var onEntitlementMayHaveChanged: (@MainActor () async -> Void)?

    // nonisolated(unsafe) so the nonisolated deinit can cancel it. A Task handle
    // is Sendable and cancel() is safe from any context; the plain `nonisolated`
    // the compiler suggests is rejected on an @Observable mutable stored property.
    private nonisolated(unsafe) var updatesListener: Task<Void, Never>?

    init(api: any PurchaseVerifying) {
        self.api = api
        // Start the listener immediately: a transaction can arrive at any time
        // (a renewal, a deferred Ask-to-Buy approval, a purchase made on another
        // device) and must be forwarded to the server even if no paywall is up.
        updatesListener = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(verification: result, finishOnServerOK: true)
            }
        }
    }

    deinit { updatesListener?.cancel() }

    // MARK: - Products

    func loadProducts() async {
        guard !isLoadingProducts else { return }
        isLoadingProducts = true
        defer { isLoadingProducts = false; didAttemptLoad = true }
        do {
            let loaded = try await Product.products(for: StoreProductID.all)
            // Stable order: monthly first, then annual, then anything else.
            products = loaded.sorted { lhs, rhs in
                Self.rank(lhs.id) < Self.rank(rhs.id)
            }
            lastError = nil
        } catch {
            // TODO(A4-apple): until the products exist in App Store Connect this
            // returns empty / errors; the paywall renders its unavailable state.
            AppLog.error("storekit_load_products_failed: \(error.localizedDescription)")
            lastError = "Pricing is unavailable right now. Please try again."
        }
    }

    private static func rank(_ id: String) -> Int {
        switch id {
        case StoreProductID.proMonthly: return 0
        case StoreProductID.proAnnual: return 1
        default: return 2
        }
    }

    // MARK: - Purchase

    func purchase(_ product: Product) async -> PurchaseOutcome {
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                // Paid, but Pro is billing's to grant: say what it said.
                let verdict = await handle(verification: verification, finishOnServerOK: true)
                return verdict.purchaseOutcome
            case .pending:
                // Ask-to-Buy / deferred. The transaction (if approved) will come
                // through Transaction.updates later.
                return .pending
            case .userCancelled:
                return .userCancelled
            @unknown default:
                return .failed("Purchase could not be completed.")
            }
        } catch {
            AppLog.error("storekit_purchase_failed: \(error.localizedDescription)")
            return .failed("Purchase failed. Please try again.")
        }
    }

    // MARK: - Restore (MUST work without a permanent account)

    /// Restore Purchases. Two-part, and reachable from the paywall WITHOUT the
    /// user signing in to a permanent account:
    ///   1. `AppStore.sync()` pulls the account's transactions from the App
    ///      Store (this needs the Apple ID, never our own auth).
    ///   2. Every current entitlement's JWS is re-sent to the server so it can
    ///      re-activate the entitlement for whatever identity is signed in.
    ///
    /// Because the app runs under an anonymous Firebase identity by default
    /// (A6.3), an ID token always exists, so step 2 succeeds pre-permanent-
    /// account. A missing Restore button is a top App Review rejection reason,
    /// which is why it lives on the paywall and calls straight through here.
    ///
    /// Ends with a `RestoreOutcome` the caller shows: restored, nothing on this
    /// Apple Account, or why not (another AlgoMinutes account's, unreachable).
    @discardableResult
    func restore() async -> RestoreOutcome {
        do {
            try await AppStore.sync()
        } catch {
            // A cancelled sync is not a failure worth alarming the user over;
            // the current entitlements are still sent below.
            AppLog.error("storekit_sync_failed: \(error.localizedDescription)")
        }
        let verdicts = await syncCurrentEntitlements(finishOnServerOK: false)
        await onEntitlementMayHaveChanged?()
        let outcome = RestoreOutcome.from(verdicts)
        AppLog.info("restore_finished: outcome=\(outcome) receipts=\(verdicts.count)")
        return outcome
    }

    /// Forward every currently-owned entitlement's JWS to the server. Used by
    /// restore and on launch so the server re-confirms an entitlement bought on
    /// another device. Returns billing's verdict on each.
    @discardableResult
    func syncCurrentEntitlements(finishOnServerOK: Bool = false) async -> [ReceiptVerdict] {
        var verdicts: [ReceiptVerdict] = []
        for await result in Transaction.currentEntitlements {
            verdicts.append(await handle(verification: result, finishOnServerOK: finishOnServerOK))
        }
        return verdicts
    }

    // MARK: - Manage / cancel

    /// Deep-link to the system subscription management screen (A9.5
    /// manage/cancel route). Uses the modern sheet where a scene is available,
    /// and falls back to the canonical management URL otherwise.
    func showManageSubscriptions() async {
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) {
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                await onEntitlementMayHaveChanged?()
                return
            } catch {
                AppLog.error("storekit_manage_failed: \(error.localizedDescription)")
            }
        }
        // Fallback: Apple's stable management URL (not web pricing — this is the
        // system subscriptions screen).
        if let url = URL(string: "https://apps.apple.com/account/subscriptions") {
            await UIApplication.shared.open(url)
        }
    }

    // MARK: - Grace period / billing retry

    /// Whether the Pro subscription is in a grace / billing-retry period, so the
    /// paywall can show a "update your payment method" nudge while access is
    /// temporarily preserved. Best-effort; the server entitlement remains the
    /// authority on whether access is actually granted.
    func isInGracePeriod() async -> Bool {
        guard let product = products.first(where: { $0.id == StoreProductID.proMonthly })
            ?? products.first,
              let statuses = try? await product.subscription?.status else { return false }
        return statuses.contains { status in
            status.state == .inGracePeriod || status.state == .inBillingRetryPeriod
        }
    }

    // MARK: - Verification plumbing

    /// Forward a transaction's signed JWS to the server for validation, then
    /// (optionally) finish it. We finish only after the server confirms, so a
    /// transient server outage leaves the transaction to be re-delivered rather
    /// than dropped. A refused receipt (`rejected`) is left unfinished too:
    /// StoreKit offers it again, and a later sign-in to the right account
    /// can still claim it. Returns billing's verdict; every one but
    /// `accepted` is logged by `ReceiptVerdict.check`.
    @discardableResult
    private func handle(
        verification: VerificationResult<Transaction>,
        finishOnServerOK: Bool
    ) async -> ReceiptVerdict {
        // Always forward the raw JWS — the server is the verifier of record, so
        // even a locally-`unverified` result is its call to make, not ours.
        let verdict = await ReceiptVerdict.check(jws: verification.jwsRepresentation, with: api)
        if verdict == .accepted {
            if finishOnServerOK, case .verified(let transaction) = verification {
                await transaction.finish()
            }
            await onEntitlementMayHaveChanged?()
        }
        return verdict
    }
}
