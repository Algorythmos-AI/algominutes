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

    private enum Step { case ready, consent, broadcast, micDenied }
    @State private var step: Step = .ready
    @State private var permissionChecked = false
    @State private var micStatus = MicPermission.current
    @AppStorage("instant_recorder_consent_shown") private var consentShownBefore = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

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
                    Text("AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded, then transcribed and summarised by Google Cloud's speech and AI services, and kept in your account until you delete it.")
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Checkbox is required EVERY session, parity with the web.
                ConsentCheckbox(
                    isChecked: $permissionChecked,
                    text: "I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded."
                )
                // Said before iOS asks (only while it hasn't yet), so the prompt isn't a surprise.
                if micStatus == .undetermined {
                    Label(MicPermission.explainer, systemImage: "mic.fill")
                        .font(Typography.body(14))
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                VStack(spacing: 10) {
                    Button(permissionChecked ? "Start recording" : "Tick the box to start") {
                        consentShownBefore = true
                        // A10 §5 seam: record the per-session acknowledgement on
                        // the shared gate the recorder evaluates in start(). The
                        // §4 layer replaces what "satisfied" means, not this call.
                        env.consentGate.acknowledge()
                        Task { await startWithMicrophone() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!permissionChecked)
                    .opacity(permissionChecked ? 1 : 0.5)
                    // The same notice, acknowledged for the next capture of another
                    // app's audio (H11/L9: it covers that one capture). Shown only while the server allows it (AppSwitches: the
                    // broadcast kill switch).
                    if env.switches.broadcastCapture {
                        Button("Capture audio from another app") {
                            consentShownBefore = true
                            env.consentGate.acknowledge(for: .appAudio)
                            withAnimation(.spring(duration: 0.3)) { step = .broadcast }
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(!permissionChecked)
                        .opacity(permissionChecked ? 1 : 0.5)
                    }
                    Button("Cancel") { dismiss() }
                        .buttonStyle(SecondaryButtonStyle())
                }

            case .micDenied:
                Text(MicPermission.deniedTitle)
                    .font(Typography.heading(22, weight: .bold))
                    .foregroundStyle(Theme.heading)
                Text(MicPermission.deniedMessage)
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                VStack(spacing: 10) {
                    if let url = MicPermission.settingsURL {
                        Button("Open Settings") { openURL(url) }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                    Button("Not now") { dismiss() }
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
        // Back from Settings with the microphone on: carry on to recording.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            micStatus = MicPermission.current
            if step == .micDenied, micStatus == .granted { openRecordingScreen() }
        }
    }

    /// Start recording once the microphone is allowed: ask iOS while this sheet
    /// is still up (the explainer said so), or offer Settings if it was refused.
    private func startWithMicrophone() async {
        switch MicPermission.route(for: MicPermission.current) {
        case .record:
            openRecordingScreen()
        case .ask:
            let granted = await MicPermission.request()
            micStatus = MicPermission.current
            if granted { openRecordingScreen() } else { withAnimation(.spring(duration: 0.3)) { step = .micDenied } }
        case .openSettings:
            withAnimation(.spring(duration: 0.3)) { step = .micDenied }
        }
    }

    private func openRecordingScreen() {
        dismiss()
        flow.isRecordingScreenPresented = true
    }
}
