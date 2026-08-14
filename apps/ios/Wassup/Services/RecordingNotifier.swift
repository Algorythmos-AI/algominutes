import UIKit
import UserNotifications

/// Tells the doctor when a recording stopped without them asking it to.
///
/// `UNUserNotificationCenter` appeared nowhere in this app. Every automatic
/// stop — the 2-hour cap, an un-resumable interruption, a lost microphone, the
/// disk filling up — set a flag whose only consumer was a sheet in
/// `RecordingView`. If the phone was in a pocket, the sheet was raised behind a
/// locked screen and nothing was uploaded until the app was next opened. The
/// recording was safe; the doctor had no way to know it had ended.
@MainActor
enum RecordingNotifier {
    /// Ask at the moment the first recording starts, not at launch.
    ///
    /// A notification prompt on first run, before the app has done anything,
    /// gets denied — and iOS only ever asks once, so a denial there is
    /// permanent. Asking a beat after someone has committed to recording is the
    /// moment it makes sense to them. Call this *after* the microphone prompt
    /// has resolved so the two never stack.
    static func requestAuthorizationIfNeeded() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        do {
            // Deliberately not .provisional: provisional notifications arrive
            // silently in Notification Center, which is precisely wrong for
            // "your recording just stopped". Also not .timeSensitive — that
            // needs an entitlement, and this app signs with a fixed manual
            // provisioning profile.
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            // Not being able to ask is not a failure worth surfacing; the
            // in-app UI still carries the same message.
            AppLog.info("notification_authorization_failed: \(error.localizedDescription)")
        }
    }

    /// Post a notification, unless the doctor is already looking at the app —
    /// in which case the in-app alert is the better channel and a banner over
    /// the top of it is just noise.
    static func recordingStopped(message: String) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = "Recording stopped"
        content.body = message
        content.sound = .default
        // nil trigger = deliver now.
        let request = UNNotificationRequest(
            identifier: "recording-stopped-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                AppLog.error("notification_post_failed: \(error.localizedDescription)")
            }
        }
    }
}
