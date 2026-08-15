import Foundation
import SwiftUI

/// A7.3 — one place a note deep link lands so the UI can react to it.
///
/// The AppDelegate (push taps, `UNUserNotificationCenterDelegate`) and the app's
/// `onOpenURL` (the `algominutes://note/<id>` scheme) both write `pendingNoteId`
/// here; `HomeView` observes it and drives its existing `selectedNoteId`
/// navigation, then clears it. A shared singleton so the AppDelegate — which has
/// no access to the SwiftUI environment — can reach it, and also injected into
/// the environment so views observe it through the Observation framework.
@Observable
@MainActor
final class DeepLinkRouter {
    static let shared = DeepLinkRouter()

    /// The note a deep link asked us to open. Set by push/URL handlers, consumed
    /// and cleared by the first view that can navigate.
    var pendingNoteId: String?

    private init() {}

    /// Route a parsed note id. Safe to call from any deep-link source.
    func open(noteId: String) {
        guard !noteId.isEmpty else { return }
        pendingNoteId = noteId
    }

    /// Route from a raw notification `userInfo` payload (mirrors
    /// `NotificationPayload` in the async contract: `deepLink` or `noteId`).
    func handle(userInfo: [AnyHashable: Any]) {
        if let link = userInfo["deepLink"] as? String,
           let id = DeepLink.noteId(fromString: link) {
            open(noteId: id)
        } else if let id = userInfo["noteId"] as? String {
            open(noteId: id)
        }
    }
}

/// Parses the internal `algominutes://note/<id>` scheme.
enum DeepLink {
    static let scheme = "algominutes"

    /// Canonical link into a note — mirrors `noteDeepLink(noteId)` in
    /// `packages/contracts/src/schemas/async.ts`.
    static func noteURL(noteId: String) -> String { "\(scheme)://note/\(noteId)" }

    static func noteId(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "note" else { return nil }
        // algominutes://note/<id> → path is "/<id>".
        let id = url.lastPathComponent
        return id.isEmpty || id == "/" ? nil : id
    }

    static func noteId(fromString string: String) -> String? {
        URL(string: string).flatMap(noteId(from:))
    }
}
