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

    private enum Step { case ready, consent, broadcast }
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
                    // The same consent covers capturing another app's audio.
                    // Shown only while the server allows it (AppSwitches: the
                    // broadcast kill switch).
                    if env.switches.broadcastCapture {
                        Button("Capture audio from another app") {
                            consentShownBefore = true
                            env.consentGate.acknowledge()
                            withAnimation(.spring(duration: 0.3)) { step = .broadcast }
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(!permissionChecked)
                        .opacity(permissionChecked ? 1 : 0.5)
                    }
                    Button("Cancel") { dismiss() }
                        .buttonStyle(SecondaryButtonStyle())
                }

            case .broadcast:
                Text("Capture another app")
                    .font(Typography.heading(22, weight: .bold))
                    .foregroundStyle(Theme.heading)
                Text("For a call in another app: tap the button below, choose AlgoMinutes, keep the microphone on so your own voice is included, and tap Start Broadcast. Then switch to your call. To stop, tap the red indicator at the top of the screen. When you come back to AlgoMinutes, the recording becomes a note.")
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    BroadcastPickerView()
                        .frame(width: 72, height: 72)
                        .accessibilityLabel("Start capturing another app's audio")
                    Spacer()
                }
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface)
    }
}
