import UIKit

/// Background time for work that must finish once the app leaves the screen
/// (RELEASE.md rev 11, H3/L10): completing an upload session and kicking
/// processing off. Begun before the work's first await and ended when it's
/// done; if the system's time runs out first, the expiration handler ends it,
/// because a task left running past that gets the app killed. Work cut off
/// that way is picked up on the next launch (resumePendingUploads).
@MainActor
final class BackgroundActivity {
    private let name: String
    private var id: UIBackgroundTaskIdentifier = .invalid

    private init(name: String) {
        self.name = name
    }

    static func begin(_ name: String) -> BackgroundActivity {
        let activity = BackgroundActivity(name: name)
        // A strong capture on purpose: the handler must be able to end the task
        // even if its owner has let go of it.
        activity.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated {
                AppLog.error("background_time_expired name=\(activity.name)")
                activity.end()
            }
        }
        return activity
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
