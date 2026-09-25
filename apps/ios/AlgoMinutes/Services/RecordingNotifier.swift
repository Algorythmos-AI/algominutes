import UIKit
import UserNotifications

/// Tells the user when a recording stopped without them asking it to.
///
/// `UNUserNotificationCenter` appeared nowhere in this app. Every automatic
/// stop — the recording cap, an un-resumable interruption, a lost microphone, the
/// disk filling up — set a flag whose only consumer was a sheet in
/// `RecordingView`. If the phone was in a pocket, the sheet was raised behind a
/// locked screen and nothing was uploaded until the app was next opened. The
/// recording was safe; the user had no way to know it had ended.
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
        switch settings.authorizationStatus {
        case .notDetermined:
            do {
                // Deliberately not .provisional: provisional notifications arrive
                // silently in Notification Center, which is precisely wrong for
                // "your recording just stopped". Also not .timeSensitive — that
                // needs an entitlement, and this app signs with a fixed manual
                // provisioning profile.
                let granted = try await center.requestAuthorization(options: [.alert, .sound])
                if granted { registerForRemoteNotifications() }
            } catch {
                // Not being able to ask is not a failure worth surfacing; the
                // in-app UI still carries the same message.
                AppLog.info("notification_authorization_failed: \(error.localizedDescription)")
            }
        case .authorized, .provisional, .ephemeral:
            // Already granted on a prior run — re-arm APNs so the token refreshes.
            registerForRemoteNotifications()
        default:
            break
        }
    }

    /// A7.3: kick APNs registration. The token lands in the AppDelegate's
    /// `didRegisterForRemoteNotificationsWithDeviceToken`. Triggered here so it
    /// happens after the first recording (alongside the permission request),
    /// never at launch.
    ///
    /// TODO(A4-apple): this needs GoogleService-Info.plist + the APNs
    /// capability/entitlement to actually succeed and to exchange for an FCM
    /// token; until then it is a harmless no-op on device.
    private static func registerForRemoteNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Post a notification, unless the user is already looking at the app —
    /// in which case the in-app alert is the better channel and a banner over
    /// the top of it is just noise.
    static func recordingStopped(message: String, noteId: String? = nil) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = "Recording stopped"
        content.body = message
        content.sound = .default
        // A7.3: carry the deep link when we already know the note, so a tap opens
        // it (mirrors NotificationPayload in the async contract).
        if let noteId {
            content.userInfo = ["noteId": noteId, "deepLink": DeepLink.noteURL(noteId: noteId)]
        }
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

    /// A7.3 local fallback for a server `note_ready` / `note_failed` push (the
    /// channel used when push is declined or not yet wired). Carries the deep
    /// link so a tap routes to the note via `DeepLinkRouter`. Suppressed while
    /// the app is active — the in-app UI already reflects the change.
    static func noteFinished(noteId: String, title: String, ready: Bool) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = ready ? "Your notes are ready" : "Processing failed"
        content.body = ready
            ? "\(title) is ready to read."
            : "\(title) couldn't be processed. Tap to try again."
        content.sound = .default
        content.userInfo = ["noteId": noteId, "deepLink": DeepLink.noteURL(noteId: noteId)]
        let request = UNNotificationRequest(
            identifier: "note-\(ready ? "ready" : "failed")-\(noteId)",
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
