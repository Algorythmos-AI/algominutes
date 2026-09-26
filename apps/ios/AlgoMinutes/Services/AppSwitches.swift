import Foundation
import Observation

/// Server-side feature switches (`GET /v1/config`, `AppConfigResponse` in
/// packages/contracts), so a feature can be turned off without a build.
///
/// `broadcastCapture` gates *Capture audio from another app*, the broadcast
/// extension: the top App Review risk, and the one feature most likely to need
/// hiding in a hurry. The last answer is kept, so an offline launch shows what
/// the server last said; before any answer it's hidden, so a build the switch
/// was meant to cover never shows it by default.
@MainActor
@Observable
final class AppSwitches {
    private(set) var broadcastCapture: Bool

    @ObservationIgnored private let defaults: UserDefaults
    private static let broadcastKey = "appSwitches.broadcastCapture"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        broadcastCapture = defaults.object(forKey: Self.broadcastKey) as? Bool ?? false
    }

    /// Ask the server again. A failure keeps the last answer.
    func refresh(fetch: () async throws -> AppConfigResponse) async {
        do {
            let config = try await fetch()
            broadcastCapture = config.broadcastCapture
            defaults.set(config.broadcastCapture, forKey: Self.broadcastKey)
        } catch {
            AppLog.error("app_config_fetch_failed: \(error.localizedDescription)")
        }
    }
}

/// Mirrors `AppConfigResponse` (packages/contracts/src/schemas/appConfig.ts).
struct AppConfigResponse: Decodable, Equatable {
    let broadcastCapture: Bool
}
