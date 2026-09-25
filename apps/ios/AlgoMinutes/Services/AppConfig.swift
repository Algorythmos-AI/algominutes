import Foundation

/// Per-build-configuration endpoints. `project.yml` sets API_BASE_URL and
/// BILLING_BASE_URL for Debug, Staging and Release, and Info.plist carries them
/// as `AlgoMinutesAPIBaseURL` / `AlgoMinutesBillingBaseURL`, so no build points
/// at an origin it wasn't configured for.
enum AppConfig {
    static let apiBaseURLKey = "AlgoMinutesAPIBaseURL"
    static let billingBaseURLKey = "AlgoMinutesBillingBaseURL"

    /// Used only if a build's Info.plist lacks a valid value (never expected).
    static let fallbackBaseURL = URL(string: "https://api.algominutes.com")!

    /// The api service: every /v1 route except billing's.
    static let apiBaseURL = baseURL(forKey: apiBaseURLKey)
    /// The billing service (/v1/purchases/verify): its own Cloud Run host.
    static let billingBaseURL = baseURL(forKey: billingBaseURLKey)

    static func baseURL(forKey key: String, info: [String: Any]? = Bundle.main.infoDictionary) -> URL {
        if let raw = info?[key] as? String, let url = validatedBaseURL(raw) { return url }
        return fallbackBaseURL
    }

    /// An https origin with a host and nothing after it: what the clients
    /// append `v1/...` to. Anything else (http, a path, a query, an unexpanded
    /// `$(API_BASE_URL)`) is rejected.
    static func validatedBaseURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme == "https",
              let host = components.host, !host.isEmpty,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let url = components.url
        else { return nil }
        return url
    }
}
