import Foundation

/// The one billing call StoreKitService makes, as a seam the tests can fake.
protocol PurchaseVerifying: Sendable {
    func verifyPurchase(jws: String) async throws -> VerifyPurchaseResponse
}

extension APIClient: PurchaseVerifying {}

/// Why billing refused a receipt (services/billing/src/routes/verify.js).
enum ReceiptRejection: Equatable, Sendable {
    /// 409 "Receipt already linked to another account": the subscription is another uid's, e.g. a guest who
    /// bought, signed out, and is now on another account.
    case linkedToAnotherAccount
    /// 409 "Receipt revoked": Apple refunded or revoked it.
    case revoked
    /// 400 (an invalid receipt, no active period) or `ok: false`.
    case notVerified
}

/// What billing said about one StoreKit transaction. Only `accepted` finishes the transaction; the rest leave it
/// unfinished, so StoreKit hands it over again (Transaction.updates, and the launch's re-sync).
enum ReceiptVerdict: Equatable, Sendable {
    case accepted
    case rejected(ReceiptRejection)
    /// No answer we can trust (offline, a timeout, a 5xx, an expired token): try again later.
    case unreachable

    /// verify.js's `error` strings for its two 409s, matched exactly.
    static let linkedToAnotherAccountError = "Receipt already linked to another account"
    static let revokedError = "Receipt revoked"

    /// Send the transaction's JWS to billing and say what came back. Every answer but `accepted` is logged.
    static func check(jws: String, with billing: any PurchaseVerifying) async -> ReceiptVerdict {
        do {
            let response = try await billing.verifyPurchase(jws: jws)
            let verdict = from(response: response)
            if verdict != .accepted {
                AppLog.error("verify_purchase_not_ok: entitlementState=\(response.entitlementState)")
            }
            return verdict
        } catch {
            let verdict = from(error: error)
            AppLog.error("verify_purchase_failed: verdict=\(verdict) \(error.localizedDescription)")
            return verdict
        }
    }

    static func from(response: VerifyPurchaseResponse) -> ReceiptVerdict {
        response.ok ? .accepted : .rejected(.notVerified)
    }

    /// Billing's 400 and 409 are its verdict on the receipt. Anything else (no connection, a 401 token refresh, a
    /// 429, a 5xx, an unreadable body) is not, and the purchase is confirmed later.
    static func from(error: Error) -> ReceiptVerdict {
        guard let apiError = error as? APIError, case .http(let status, let code) = apiError else { return .unreachable }
        switch status {
        case 409 where code == linkedToAnotherAccountError: return .rejected(.linkedToAnotherAccount)
        case 409 where code == revokedError: return .rejected(.revoked)
        case 400, 409: return .rejected(.notVerified)
        default: return .unreachable
        }
    }

    /// What the paywall shows after StoreKit took the payment.
    var purchaseOutcome: StoreKitService.PurchaseOutcome {
        switch self {
        case .accepted: return .success
        case .rejected(let reason): return .failed(reason.purchaseMessage)
        case .unreachable: return .confirmationDelayed
        }
    }
}

extension ReceiptRejection {
    /// The sentence a refused purchase ends with: what happened, and what to do.
    var purchaseMessage: String {
        switch self {
        case .linkedToAnotherAccount:
            return RestoreOutcome.belongsToAnotherAccount.message
        case .revoked:
            return "Apple refunded or cancelled this purchase, so it can’t unlock Pro."
        case .notVerified:
            return "We couldn’t verify this purchase with the App Store, so Pro isn’t on yet. Tap Restore Purchases to try again."
        }
    }
}

extension StoreKitService.PurchaseOutcome {
    static let confirmationDelayedMessage =
        "We couldn’t confirm your purchase yet. It will finish automatically; you won’t be charged twice."
}

/// How Restore Purchases ended, in the paywall and in Settings. Always a sentence, never silence.
enum RestoreOutcome: Equatable, Sendable {
    case restored
    case nothingFound
    case belongsToAnotherAccount
    case notConfirmed
    case notRestored(ReceiptRejection)

    /// One accepted receipt is Pro, whatever else came back. Otherwise the 409 for another account, then a retry,
    /// then any other refusal. No receipts at all: nothing on this Apple Account.
    static func from(_ verdicts: [ReceiptVerdict]) -> RestoreOutcome {
        if verdicts.isEmpty { return .nothingFound }
        if verdicts.contains(.accepted) { return .restored }
        if verdicts.contains(.rejected(.linkedToAnotherAccount)) { return .belongsToAnotherAccount }
        if verdicts.contains(.unreachable) { return .notConfirmed }
        for case .rejected(let reason) in verdicts { return .notRestored(reason) }
        return .notConfirmed
    }

    var message: String {
        switch self {
        case .restored:
            return "Pro restored."
        case .nothingFound:
            return "No purchases found for this Apple Account."
        case .belongsToAnotherAccount, .notRestored(.linkedToAnotherAccount):
            return "This subscription belongs to another AlgoMinutes account. Sign in with that account to use it."
        case .notConfirmed:
            return "We couldn’t reach AlgoMinutes to restore your purchase. Check your connection and try again."
        case .notRestored(.revoked):
            return "Apple refunded or cancelled this purchase, so it can’t restore Pro."
        case .notRestored(.notVerified):
            return "We couldn’t verify your purchase with the App Store. Please try again, or contact us from Help & Support."
        }
    }
}
