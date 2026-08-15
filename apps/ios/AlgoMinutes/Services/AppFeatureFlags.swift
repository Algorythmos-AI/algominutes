import Foundation

/// Compile-time / runtime feature gates for reliability work that cannot be
/// verified in this environment and must ship OFF until a device confirms it.
enum AppFeatureFlags {
    /// A7.2 — route uploads through the `URLSession` background, chunked,
    /// resumable path (`BackgroundUploadService`) instead of the Firebase
    /// `putFile` path (`UploadService`).
    ///
    /// The background path survives app termination and reboot, but it depends
    /// on server endpoints that are not built yet (see
    /// `APIClient.createUploadSession`) and cannot be exercised here. The
    /// Firebase `putFile` path stays as the documented, working fallback.
    ///
    // TODO(A7.2): flip default after on-device verification.
    static let backgroundResumableUpload = false
}

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
