import Foundation

/// Per-build-configuration endpoints. `project.yml` sets API_BASE_URL and
/// BILLING_BASE_URL for Debug, Staging and Release, and Info.plist carries them
/// as `AlgoMinutesAPIBaseURL` / `AlgoMinutesBillingBaseURL`, so no build points
/// at an origin it wasn't configured for.
enum AppConfig {
    static let apiBaseURLKey = "AlgoMinutesAPIBaseURL"
    static let billingBaseURLKey = "AlgoMinutesBillingBaseURL"
    static let updateURLKey = "AlgoMinutesUpdateURL"

    /// Used only if a build's Info.plist lacks a valid value (never expected).
    static let fallbackBaseURL = URL(string: "https://api.algominutes.com")!

    /// The api service: every /v1 route except billing's.
    static let apiBaseURL = baseURL(forKey: apiBaseURLKey)
    /// The billing service (/v1/purchases/verify): its own Cloud Run host.
    static let billingBaseURL = baseURL(forKey: billingBaseURLKey)

    /// Where the update screen sends the user (UPDATE_URL): the TestFlight app
    /// while builds ship through TestFlight. Nil when unset, and the screen
    /// then shows no button.
    static let updateURL = updateURL(info: Bundle.main.infoDictionary)

    static func updateURL(info: [String: Any]?) -> URL? {
        guard let raw = (info?[updateURLKey] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, !raw.hasPrefix("$("),
              let url = URL(string: raw), let scheme = url.scheme,
              ["itms-beta", "itms-apps", "https"].contains(scheme)
        else { return nil }
        return url
    }

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
