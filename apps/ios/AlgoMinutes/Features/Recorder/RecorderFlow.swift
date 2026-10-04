import SwiftUI

@Observable
final class RecorderFlowState {
    var isRecordingScreenPresented = false
}

/// One consent sheet (RELEASE.md rev 11, H13 / UX2): what's recorded, the
/// permission tick, Start. The "Ready to record?" step before it said the same
/// thing and cost a tap before every recording.
///
/// The words scroll and the buttons are pinned under them, so Start is always
/// on screen: on a small iPhone at a large text size it used to fall off the
/// bottom of a sheet that didn't scroll.
struct RecorderConsentFlow: View {
    @Environment(AppEnvironment.self) private var env
    @Binding var flow: RecorderFlowState
    let onNoteCreated: (String?) -> Void

    enum Step: Equatable { case consent, broadcast, micDenied }
    /// Where the sheet opens: straight at the consent, with nothing before it.
    static let firstStep = Step.consent
    @State private var step: Step = RecorderConsentFlow.firstStep
    @State private var permissionChecked = false
    @State private var micStatus = MicPermission.current
    @AppStorage("instant_recorder_consent_shown") private var consentShownBefore = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 16) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) { words }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            VStack(spacing: 10) { actions }
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

    /// What the step says. Scrolls.
    @ViewBuilder private var words: some View {
        switch step {
        case .consent:
            Text("Before you record")
                .font(Typography.heading(22, weight: .bold))
                .foregroundStyle(Theme.heading)
            // Short for someone who has read it before; in full the first time.
            Text(consentShownBefore
                 ? "AlgoMinutes records audio from this device for as long as you're recording. Afterwards it's transcribed and summarised for you. You can stop at any time."
                 : "AlgoMinutes records audio from this device for as long as you're recording. The audio is uploaded, then transcribed and summarised by Google Cloud's speech and AI services, and kept in your account until you delete it. You can stop at any time.")
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .fixedSize(horizontal: false, vertical: true)
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

        case .micDenied:
            Text(MicPermission.deniedTitle)
                .font(Typography.heading(22, weight: .bold))
                .foregroundStyle(Theme.heading)
            Text(MicPermission.deniedMessage)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .fixedSize(horizontal: false, vertical: true)

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
        }
    }

    /// The step's buttons. Pinned under the words, so they're always on screen.
    @ViewBuilder private var actions: some View {
        switch step {
        case .consent:
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

        case .micDenied:
            if let url = MicPermission.settingsURL {
                Button("Open Settings") { openURL(url) }
                    .buttonStyle(PrimaryButtonStyle())
            }
            Button("Not now") { dismiss() }
                .buttonStyle(SecondaryButtonStyle())

        case .broadcast:
            Button("Done") { dismiss() }
                .buttonStyle(SecondaryButtonStyle())
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
