import AVFoundation
import UIKit

/// The microphone permission, and what the app does about it (RELEASE.md PR 10a).
///
/// iOS asks for the microphone once. The app used to ask over the black
/// recording screen, with nothing said first, and a denial ended in an alert
/// with only OK. Now the consent sheet says what's coming before iOS asks, and
/// a denial offers Settings.
enum MicPermission {
    enum Status: Equatable { case undetermined, denied, granted }
    /// What "Start recording" does for each status.
    enum Route: Equatable { case record, ask, openSettings }

    static func route(for status: Status) -> Route {
        switch status {
        case .granted: return .record
        case .undetermined: return .ask
        case .denied: return .openSettings
        }
    }

    static var current: Status {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined // .undetermined, and anything newer: asking is the safe answer
        }
    }

    static func request() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// This app's page in Settings, where the microphone switch is.
    static var settingsURL: URL? { URL(string: UIApplication.openSettingsURLString) }

    static let explainer = "Next, iOS asks to use the microphone. Tap Allow so AlgoMinutes can record."
    static let deniedTitle = "Turn on the microphone"
    static let deniedMessage = "AlgoMinutes needs the microphone to record. Open Settings, turn on Microphone, then come back to record."
}
