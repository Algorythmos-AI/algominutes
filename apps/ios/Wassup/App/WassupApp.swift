import FirebaseCore
import GoogleSignIn
import SwiftUI

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Firebase is configured in WassupApp.init() so it's ready before any
        // @State service touches Auth/Firestore; keep this as a safety net.
        FirebaseBootstrap.configureIfNeeded()
        return true
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
struct WassupApp: App {
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
                .preferredColorScheme(.dark)
                .tint(Theme.heading)
                .onOpenURL { url in
                    GIDSignIn.sharedInstance.handle(url)
                }
        }
    }
}
