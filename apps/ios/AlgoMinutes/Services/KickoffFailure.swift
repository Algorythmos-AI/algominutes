import Foundation

/// What the app does when POST /v1/process refuses a kickoff
/// (services/api/src/routes/process-intelligence.js). A 202 is a success: the
/// note is already in flight, from an earlier attempt.
enum KickoffFailure {
    /// 402: out of included minutes. The paywall, with the entitlement the
    /// server sent (nil when it had none).
    case quota(EntitlementResponse?)
    /// 426: this build is older than the server's minimum. APIClient has
    /// already raised the update screen.
    case updateRequired
    /// 413 (too large) or 429 (too many uploads): the server has already
    /// marked the note failed with this message, Postgres first, so the client
    /// shows it and doesn't overwrite the note with a vaguer one.
    case refused(message: String)
    /// 404 (the note or its audio is gone), a network failure or a 5xx: the
    /// client marks the note itself.
    case failed(message: String)

    /// Shown on a note that couldn't process because the user is out of quota
    /// (A9.4), when there's a paywall: it carries the actual upgrade path.
    static let quotaMessage = "You've used up your included minutes. Upgrade to Pro to keep processing."

    /// The quota message for this build. Without a paywall (PAYWALL_ENABLED=NO:
    /// no products on sale), "Upgrade to Pro" would be a dead end, so it says
    /// what's true instead: when the minutes come back, or where to ask.
    static func quotaMessage(_ entitlement: EntitlementResponse?, paywallEnabled: Bool, locale: Locale = .current) -> String {
        if paywallEnabled { return quotaMessage }
        guard let e = entitlement, let included = e.includedMinutes, included > 0 else {
            return "Processing isn't included on your account right now. You can reach us from Settings › Help & Support."
        }
        let minutes = Int(included.rounded()).formatted(.number.locale(locale))
        if let reset = nextPeriodStart(e.billingPeriod) {
            let day = reset.formatted(Date.FormatStyle(locale: locale, timeZone: TimeZone(identifier: "UTC")!).day().month(.wide))
            return "You've used this month's \(minutes) included minutes. They reset on \(day)."
        }
        return "You've used this month's \(minutes) included minutes. They reset at the start of next month."
    }

    /// The first instant of the month after a "YYYY-MM" billing period, in UTC
    /// (the server meters by calendar month in UTC).
    static func nextPeriodStart(_ billingPeriod: String) -> Date? {
        let parts = billingPeriod.split(separator: "-")
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]), (1...12).contains(month) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let start = calendar.date(from: DateComponents(year: year, month: month, day: 1)) else { return nil }
        return calendar.date(byAdding: .month, value: 1, to: start)
    }
    static let updateMessage = "Please update AlgoMinutes, then try again."
    static let notFoundMessage = "We couldn't find this recording's audio. Please try again."

    init(_ error: Error, fallback: String) {
        switch error {
        case APIError.quotaExceeded(let entitlement):
            self = .quota(entitlement)
        case APIError.updateRequired:
            self = .updateRequired
        case APIError.http(let status, let message) where status == 413 || status == 429:
            self = .refused(message: message ?? fallback)
        case APIError.http(let status, _) where status == 404:
            self = .failed(message: Self.notFoundMessage)
        default:
            self = .failed(message: fallback)
        }
    }

    /// For the user (an alert or a blocked retry).
    var message: String {
        switch self {
        case .quota(let entitlement): return Self.quotaMessage(entitlement, paywallEnabled: AppConfig.paywallEnabled)
        case .updateRequired: return Self.updateMessage
        case .refused(let message), .failed(let message): return message
        }
    }

    /// The error the client writes on the note doc, or nil when the server
    /// already recorded the failure.
    var noteError: String? {
        switch self {
        case .refused: return nil
        default: return message
        }
    }
}
