import FirebaseCore
import FirebaseMessaging
import GoogleSignIn
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
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
        // A7.3: FirebaseMessaging turns the APNs token into the FCM token the
        // notifier sends to, and tells us each time it changes.
        Messaging.messaging().delegate = self
        PushTokenRegistrar.shared.deleteDeviceToken = {
            try await Messaging.messaging().deleteToken()
            // A fresh token for whoever signs in next; it waits for them.
            do {
                let fresh = try await Messaging.messaging().token()
                await PushTokenRegistrar.shared.tokenRefreshed(fresh)
            } catch {
                AppLog.error("push_token_fetch_failed: \(error.localizedDescription)")
            }
        }
        return true
    }

    // MARK: - APNs / FCM registration (A7.3)

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // FirebaseMessaging exchanges it for the FCM token, which arrives in
        // messaging(_:didReceiveRegistrationToken:). The raw APNs token used to
        // be registered here; FCM rejects it, so no push could arrive.
        Messaging.messaging().apnsToken = deviceToken
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        Task { @MainActor in
            await PushTokenRegistrar.shared.tokenRefreshed(fcmToken)
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
            // Recreate the session so the system delivers what it queued for it.
            BackgroundUploadService.shared?.reconnect()
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
        guard FirebaseApp.app() == nil else { return }
        // GoogleService-Info.plist is git-ignored and injected per environment at
        // build time (A4). When it is present, configure normally. When it is
        // absent (CI / app-hosted unit tests), configure with placeholder
        // options so FirebaseApp — and the lazily-constructed Auth/Firestore
        // instances the app touches at launch — exist rather than trapping.
        // No live Firebase calls are made in that mode.
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
        } else {
            let options = FirebaseOptions(
                googleAppID: "1:000000000000:ios:0000000000000000",
                gcmSenderID: "000000000000",
            )
            // Firebase (FIRInstallations) validates the API key's shape at
            // configure time. Assemble a format-valid but obviously-fake key at
            // runtime (fragments so the raw shape isn't a source literal); no
            // live Firebase call is ever made with it.
            options.apiKey = "AIza" + "SyDUMMY" + String(repeating: "0", count: 28)
            options.projectID = "algominutes-ci"
            FirebaseApp.configure(options: options)
            AppLog.error("firebase_config_missing: configured with placeholder options (no GoogleService-Info.plist)")
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
