import Foundation

// Billing + entitlement client models (A9.4 / A9.5 / A9.6).
//
// These mirror the shared contract EXACTLY so the client and server speak the
// same shapes:
//   • EntitlementResponse / EntitlementState → packages/contracts/src/schemas/async.ts
//   • VerifyPurchaseResponse / AnalyticsEvent / BillingPeriod
//        → packages/contracts/src/schemas/billing.ts
//
// The golden rule the contract encodes: entitlement is granted ONLY from a
// server-validated receipt. The client never sets an "I'm Pro" flag — it reads
// EntitlementResponse.state from the server and renders accordingly.

/// A9.3 reverse-trial lifecycle: days 1–7 `trialing` (full features, no card);
/// after day 7 either `active` (paid) or `expired` → the thin `free_floor`.
enum EntitlementState: String, Codable, Sendable {
    case trialing
    case active
    case expired
    case freeFloor = "free_floor"
}

/// Server-resolved entitlement (async.ts `EntitlementResponse`). Field names and
/// nullability match the contract 1:1 so JSONDecoder maps them without a
/// CodingKeys map.
struct EntitlementResponse: Codable, Sendable {
    let state: EntitlementState
    /// 'free' | 'pro' | 'team' — kept as a String so an added tier does not
    /// break decoding on an older client.
    let plan: String
    let billingPeriod: String        // "YYYY-MM"
    let includedMinutes: Double?     // null = per-seat / unmetered
    let usedMinutes: Double
    let remainingMinutes: Double?    // null when includedMinutes is null
    let overQuota: Bool
    let trialEndsAt: String?         // ISO; present while trialing

    /// Whole days left in the reverse trial, floored at 0. Drives the countdown
    /// banner. Returns nil when not trialing or the date can't be parsed.
    var trialDaysRemaining: Int? {
        guard state == .trialing, let iso = trialEndsAt,
              let end = Self.parseISO(iso)
        else { return nil }
        let seconds = end.timeIntervalSinceNow
        guard seconds > 0 else { return 0 }
        return Int((seconds / 86_400).rounded(.up))
    }

    /// The server may or may not stamp fractional seconds; try both rather than
    /// silently dropping the banner when the format differs by a millisecond.
    private static func parseISO(_ iso: String) -> Date? {
        ISO8601DateFormatter.entitlement.date(from: iso)
            ?? ISO8601DateFormatter.entitlementPlain.date(from: iso)
    }

    /// After day 7 the free floor gates metered actions (new recordings/imports)
    /// behind the paywall. `active` and `trialing` never gate.
    var gatesMeteredActions: Bool {
        switch state {
        case .trialing, .active: return false
        case .expired, .freeFloor: return true
        }
    }
}

/// Client → server purchase verification response (billing.ts
/// `VerifyPurchaseResponse`). `ok == true` means the server validated the
/// StoreKit JWS and activated the entitlement keyed to this user.
struct VerifyPurchaseResponse: Codable, Sendable {
    let ok: Bool
    /// 'active' | 'trialing' | 'free_floor'
    let entitlementState: String
}

/// A9.6 analytics funnel events (billing.ts `AnalyticsEvent`). Raw values match
/// the contract enum so the server's funnel query lines up across platforms.
enum AnalyticsEvent: String, Sendable {
    case signup
    case firstRecording = "first_recording"
    case firstSummaryViewed = "first_summary_viewed"
    case trialStarted = "trial_started"
    case trialDay7 = "trial_day7"
    case quotaHit = "quota_hit"
    case paywallViewed = "paywall_viewed"
    case purchase
    case cancellation
}

/// billing.ts `BillingPeriod`.
enum BillingPeriod: String, Sendable {
    case monthly
    case annual
}

/// StoreKit product identifiers the paywall loads.
///
/// TODO(A4-apple): these must be created in App Store Connect (Pro A$14.99/mo
/// + annual) and, for local runs, added to a .storekit configuration file.
/// Until they exist `Product.products(for:)` returns an empty set and the
/// paywall shows its "pricing unavailable" state — it never invents a price.
enum StoreProductID {
    static let proMonthly = "com.algorythmos.algominutes.pro.monthly"
    static let proAnnual = "com.algorythmos.algominutes.pro.annual"

    static let all: [String] = [proMonthly, proAnnual]
}

extension ISO8601DateFormatter {
    /// Shared parser for entitlement timestamps (handles fractional seconds).
    static let entitlement: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Same, without fractional seconds (e.g. "2026-08-22T00:00:00Z").
    static let entitlementPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
