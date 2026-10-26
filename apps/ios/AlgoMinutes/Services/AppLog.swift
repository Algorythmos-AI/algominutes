import FirebaseCore
import FirebaseCrashlytics
import os

/// The app's log (RELEASE.md PR 11). It was `print`, and `info` only in Debug,
/// so a tester's build kept nothing: a crash report arrived with no trail.
///
/// Every line goes to the unified log (Console.app, a sysdiagnose). In builds
/// that reach a device outside Xcode (Staging, Release) it's also a Crashlytics
/// breadcrumb, so the last lines before a crash arrive with the report.
///
/// Lines are event names with ids, counts and error descriptions — never a
/// note's title, transcript or summary, nor an email address. They leave the
/// device with crash reports: keep them that way.
enum AppLog {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.algorythmos.algominutes",
        category: "app"
    )

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        breadcrumb(message)
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        breadcrumb("[error] \(message)")
    }

    private static func breadcrumb(_ message: String) {
        #if !DEBUG
        // Crashlytics traps if asked for before Firebase is configured.
        guard FirebaseApp.app() != nil else { return }
        Crashlytics.crashlytics().log(message)
        #endif
    }
}
