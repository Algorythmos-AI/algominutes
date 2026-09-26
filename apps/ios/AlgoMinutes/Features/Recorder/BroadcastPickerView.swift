import ReplayKit
import SwiftUI

/// The system broadcast picker, preset to AlgoMinutes' capture extension: one
/// tap asks iOS to start capturing another app's audio (and the microphone).
/// iOS owns the confirmation and the red status indicator; the app can't start
/// a broadcast itself.
struct BroadcastPickerView: UIViewRepresentable {
    static let extensionBundleID = "com.algorythmos.algominutes.BroadcastExtension"

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 72, height: 72))
        picker.preferredExtension = Self.extensionBundleID
        picker.showsMicrophoneButton = true
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
