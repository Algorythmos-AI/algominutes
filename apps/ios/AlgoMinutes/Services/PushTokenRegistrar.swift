import Foundation

/// A7.3: the device's push token, registered for whoever is signed in.
///
/// The notifier sends through FCM (`sendEachForMulticast`), so it needs an FCM
/// registration token. The app used to register the raw APNs token, which FCM
/// rejects, so no push could ever arrive. FirebaseMessaging turns the APNs
/// token into an FCM token and refreshes it; the AppDelegate hands each one to
/// `tokenRefreshed`.
///
/// A token is registered once per signed-in user: the api keys it on the token
/// and re-homes it to the caller, so a new account on this device takes it
/// over. One that arrives before sign-in waits for it. A failed registration
/// is tried again at the next token or sign-in. On sign-out the token is
/// deleted, so the previous user's notes stop pushing to this device; FCM then
/// issues a new one for the next user.
@MainActor
final class PushTokenRegistrar {
    static let shared = PushTokenRegistrar(
        appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
        register: { token, appVersion in
            _ = try await APIClient().registerPushToken(token: token, appVersion: appVersion)
        }
    )

    typealias Register = (_ token: String, _ appVersion: String?) async throws -> Void

    /// Set at launch to FirebaseMessaging's `deleteToken`.
    var deleteDeviceToken: (() async throws -> Void)?
    /// Set at launch to FirebaseMessaging's `token()`.
    var fetchDeviceToken: (() async throws -> String)?

    private let appVersion: String?
    private let register: Register
    private var token: String?
    private var uid: String?
    private var registered: (token: String, uid: String)?

    init(appVersion: String?, register: @escaping Register) {
        self.appVersion = appVersion
        self.register = register
    }

    /// FirebaseMessaging issued (or refreshed) the device's FCM token.
    func tokenRefreshed(_ token: String?) async {
        guard let token, !token.isEmpty else { return }
        self.token = token
        await registerIfNeeded()
    }

    /// APNs gave the device its token, now handed to FirebaseMessaging. The FCM token is asked for outright, not
    /// left to the delegate: Messaging fetches one by itself only when it has no cached token at all or the APNs
    /// token changed. A device that last ran a build on the other Firebase project (staging and Release share the
    /// bundle id) keeps that project's token and never got this one's, so build 76 registered nothing on
    /// production (2026-10-27). `token()` returns the cached token when it is this project's.
    func apnsTokenArrived() async {
        guard let fetchDeviceToken else { return }
        do {
            let token = try await fetchDeviceToken()
            await tokenRefreshed(token)
        } catch {
            AppLog.error("push_token_fetch_failed: \(error.localizedDescription)")
        }
    }

    /// The signed-in user changed (`nil`: signed out).
    func userChanged(uid: String?) async {
        let signedOut = uid == nil && self.uid != nil
        self.uid = uid
        if signedOut {
            registered = nil
            token = nil
            if let deleteDeviceToken {
                do {
                    try await deleteDeviceToken()
                    AppLog.info("push_token_deleted_on_sign_out")
                } catch {
                    AppLog.error("push_token_delete_failed: \(error.localizedDescription)")
                }
            }
            return
        }
        await registerIfNeeded()
    }

    private func registerIfNeeded() async {
        guard let token, let uid else { return }
        if let registered, registered.token == token, registered.uid == uid { return }
        do {
            try await register(token, appVersion)
            // Only if nothing moved on while the request was out.
            if self.token == token, self.uid == uid { registered = (token, uid) }
            AppLog.info("push_token_registered")
        } catch {
            AppLog.error("push_token_register_failed: \(error.localizedDescription)")
        }
    }
}
