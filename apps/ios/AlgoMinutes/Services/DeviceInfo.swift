import Foundation
import UIKit

/// Non-sensitive device/app context attached to support requests and headers.
///
/// Deliberately carries only diagnostic facts — model identifier, OS version,
/// app version. It NEVER touches audio, transcripts, or note content
/// (`docs/STORE-COMPLIANCE.md` §1: support attaches diagnostic context only).
enum DeviceInfo {
    /// Marketing-ish model identifier, e.g. "iPhone15,3". Falls back to
    /// `UIDevice.model` when uname is unavailable.
    static var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            partial.append(Character(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? UIDevice.current.model : identifier
    }

    /// e.g. "iPhone15,3 · iOS 17.5". Human-readable, single-line.
    @MainActor
    static var deviceDescription: String {
        let os = UIDevice.current.systemVersion
        return "\(modelIdentifier) · iOS \(os)"
    }

    /// e.g. "1.0.0 (14)". Marketing version + build.
    static var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(version) (\(build))"
    }
}
