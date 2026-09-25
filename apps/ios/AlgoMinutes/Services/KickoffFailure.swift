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
    /// (A9.4). The paywall carries the actual upgrade path.
    static let quotaMessage = "You've used up your included minutes. Upgrade to Pro to keep processing."
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
        case .quota: return Self.quotaMessage
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
