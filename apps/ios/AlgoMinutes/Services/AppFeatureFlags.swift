import Foundation

/// User-facing upload preferences, backed by `UserDefaults` so both SwiftUI
/// (`@AppStorage`) and the uploader read the same value.
enum UploadPreferences {
    /// P1 setting: only run large background uploads on Wi-Fi. Read by
    /// `BackgroundUploadService` to gate `allowsCellularAccess`.
    static let wifiOnlyKey = "upload.wifiOnly"

    static var wifiOnly: Bool {
        // Default false: an upload on cellular is still better than a recording
        // that never leaves the device. The toggle lets a metered user opt in.
        UserDefaults.standard.bool(forKey: wifiOnlyKey)
    }
}
