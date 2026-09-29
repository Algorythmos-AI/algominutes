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
    /// Sending the notetaker from a pasted link (`notetaker.bot`): on only for
    /// the users the server allows (beta testers, until the legal opinion).
    private(set) var notetakerBot: Bool
    /// Share links (RELEASE.md PR 29): a public link that opens the web app's
    /// viewer. Off until the server says so, as the viewer's host must be public.
    private(set) var shareLinks: Bool

    @ObservationIgnored private let defaults: UserDefaults
    private static let broadcastKey = "appSwitches.broadcastCapture"
    private static let notetakerBotKey = "appSwitches.notetakerBot"
    private static let shareLinksKey = "appSwitches.shareLinks"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        broadcastCapture = defaults.object(forKey: Self.broadcastKey) as? Bool ?? false
        notetakerBot = defaults.object(forKey: Self.notetakerBotKey) as? Bool ?? false
        shareLinks = defaults.object(forKey: Self.shareLinksKey) as? Bool ?? false
    }

    /// Ask the server again. A failure keeps the last answer.
    func refresh(fetch: () async throws -> AppConfigResponse) async {
        do {
            let config = try await fetch()
            broadcastCapture = config.broadcastCapture
            defaults.set(config.broadcastCapture, forKey: Self.broadcastKey)
            // Absent (an older server) means off.
            notetakerBot = config.notetaker?.bot ?? false
            defaults.set(notetakerBot, forKey: Self.notetakerBotKey)
            shareLinks = config.shareLinks ?? false
            defaults.set(shareLinks, forKey: Self.shareLinksKey)
        } catch {
            AppLog.error("app_config_fetch_failed: \(error.localizedDescription)")
        }
    }
}

/// Mirrors `AppConfigResponse` (packages/contracts/src/schemas/appConfig.ts).
struct AppConfigResponse: Decodable, Equatable {
    let broadcastCapture: Bool
    /// The notetaker's surfaces (`NotetakerSwitches`); absent from an older server.
    let notetaker: NotetakerSwitches?
    /// Share links; absent from an older server, which means off.
    let shareLinks: Bool?

    init(broadcastCapture: Bool, notetaker: NotetakerSwitches? = nil, shareLinks: Bool? = nil) {
        self.broadcastCapture = broadcastCapture
        self.notetaker = notetaker
        self.shareLinks = shareLinks
    }

    struct NotetakerSwitches: Decodable, Equatable {
        let bot: Bool
    }
}
