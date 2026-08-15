import SwiftUI

@Observable
final class RecorderFlowState {
    var isRecordingScreenPresented = false
}

/// Two-step consent — parity with the "Ready to record?" sheet then
/// `InstantRecorderConsent` in the web app.
struct RecorderConsentFlow: View {
    @Environment(AppEnvironment.self) private var env
    @Binding var flow: RecorderFlowState
    let onNoteCreated: (String?) -> Void

    private enum Step { case ready, consent }
    @State private var step: Step = .ready
    @State private var permissionChecked = false
    @AppStorage("instant_recorder_consent_shown") private var consentShownBefore = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            switch step {
            case .ready:
                Text("Ready to record?")
                    .font(Typography.heading(22, weight: .bold))
                    .foregroundStyle(Theme.heading)
                Text("AlgoMinutes records audio from this device for as long as you're recording. Afterwards it's transcribed and summarised for you. You can stop at any time.")
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                VStack(spacing: 10) {
                    Button("Continue") {
                        withAnimation(.spring(duration: 0.3)) { step = .consent }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    Button("Cancel") { dismiss() }
                        .buttonStyle(SecondaryButtonStyle())
                }

            case .consent:
                Text("Before you record")
                    .font(Typography.heading(22, weight: .bold))
                    .foregroundStyle(Theme.heading)
                if !consentShownBefore {
                    Text("AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded to be transcribed and summarised, then kept in your account until you delete it.")
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Checkbox is required EVERY session, parity with the web.
                ConsentCheckbox(
                    isChecked: $permissionChecked,
                    text: "I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded."
                )
                Spacer()
                VStack(spacing: 10) {
                    Button(permissionChecked ? "Start recording" : "Tick the box to start") {
                        consentShownBefore = true
                        // A10 §5 seam: record the per-session acknowledgement on
                        // the shared gate the recorder evaluates in start(). The
                        // §4 layer replaces what "satisfied" means, not this call.
                        env.consentGate.acknowledge()
                        dismiss()
                        flow.isRecordingScreenPresented = true
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!permissionChecked)
                    .opacity(permissionChecked ? 1 : 0.5)
                    Button("Cancel") { dismiss() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface)
    }
}
