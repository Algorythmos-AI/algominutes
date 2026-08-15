import Foundation
import StoreKit
import UIKit

/// A10 #6: request an App Store review at a genuine moment of value — the first
/// time a user is looking at a *successful* summary — never at launch.
///
/// Rate-limited by us on top of Apple's own cap (Apple ignores the request if
/// it has prompted recently, and shows the sheet at most a few times a year).
/// We additionally fire it at most once per app version, and only after a
/// summary has actually rendered. No custom artwork — this is the system sheet.
///
/// TODO(A4-apple): in production `SKStoreReviewController.requestReview(in:)`
/// only shows on a real device with an App Store-provisioned build; in
/// dev/TestFlight it is a no-op. Nothing to test in this environment.
@MainActor
enum AppReviewController {
    private static let requestedVersionKey = "app_review.requested_version"

    /// Request a review if we haven't already asked for this app version.
    /// Call only after a successful, value-delivering moment (a summary on
    /// screen). Safe to call repeatedly — it self-limits.
    static func requestReviewIfAppropriate() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: requestedVersionKey) != version else { return }

        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return }

        defaults.set(version, forKey: requestedVersionKey)
        AppLog.info("app_review_requested version=\(version)")
        SKStoreReviewController.requestReview(in: scene)
    }
}
