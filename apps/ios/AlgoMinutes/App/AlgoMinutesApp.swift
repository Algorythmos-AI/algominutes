import FirebaseCore
import GoogleSignIn
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Firebase is configured in AlgoMinutesApp.init() so it's ready before any
        // @State service touches Auth/Firestore; keep this as a safety net.
        FirebaseBootstrap.configureIfNeeded()
        // A7.3: own notification presentation + taps so a note deep link routes.
        // NOTE: we do NOT call registerForRemoteNotifications() here — APNs
        // registration is triggered after the first recording (see
        // AppEnvironment.startRecordingCapture), never at launch.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - APNs / FCM registration (A7.3)

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let apnsHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        // TODO(A4-apple): exchange the APNs token for an FCM registration token
        // via FirebaseMessaging once GoogleService-Info.plist is registered and
        // the Messaging pod is added. Until then we forward the raw APNs token so
        // the server-side registration path can be exercised end-to-end.
        let appVersion = Bundle.main
            .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        Task {
            do {
                try await APIClient().registerPushToken(token: apnsHex, appVersion: appVersion)
                AppLog.info("push_token_registered")
            } catch {
                AppLog.error("push_token_register_failed: \(error.localizedDescription)")
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Not fatal: local notifications remain the fallback channel.
        AppLog.error("apns_register_failed: \(error.localizedDescription)")
    }

    // MARK: - Background URLSession events (A7.2)

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == BackgroundUploadService.sessionIdentifier else {
            completionHandler()
            return
        }
        Task { @MainActor in
            BackgroundUploadService.shared?.backgroundCompletionHandler = completionHandler
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// A tap on a note notification (push, or the local fallback) opens the note.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            DeepLinkRouter.shared.handle(userInfo: userInfo)
            completionHandler()
        }
    }

    /// Show the banner even when the app is foregrounded — a "note ready" or
    /// "recording stopped" is worth surfacing over whatever screen is up.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }
}

/// Configures Firebase exactly once, before any service is constructed.
/// Guards against the SwiftUI ordering where `@State` initializers run before
/// the app delegate's `didFinishLaunchingWithOptions`.
enum FirebaseBootstrap {
    private static var configured = false

    static func configureIfNeeded() {
        guard !configured else { return }
        configured = true
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        if let clientID = FirebaseApp.app()?.options.clientID {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
        }
    }
}

@main
struct AlgoMinutesApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var environment: AppEnvironment

    init() {
        FirebaseBootstrap.configureIfNeeded()
        #if DEBUG
        Theme.assertBrandFontsLoaded()
        #endif
        _environment = State(initialValue: AppEnvironment())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(environment)
                .environment(DeepLinkRouter.shared)
                .preferredColorScheme(.dark)
                .tint(Theme.heading)
                .onOpenURL { url in
                    // A7.3: route the internal note scheme; hand everything else
                    // (Google sign-in callbacks) to GoogleSignIn as before.
                    if let noteId = DeepLink.noteId(from: url) {
                        DeepLinkRouter.shared.open(noteId: noteId)
                    } else {
                        GIDSignIn.sharedInstance.handle(url)
                    }
                }
        }
    }
}
