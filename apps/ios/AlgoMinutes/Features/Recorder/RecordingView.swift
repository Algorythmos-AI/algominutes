import SwiftUI

/// Full-screen recording UI — parity with the web recording screen: pulsing
/// rings, glowing mic, MM:SS timer, near-cap warning pill, 2-hour auto-stop,
/// live waveform, red square End button.
struct RecordingView: View {

    /// Copy for the approaching-cap warning.
    ///
    /// The old version read "298s left — AlgoMinutes auto-stops at 120:00": raw
    /// seconds counting down and a timer-formatted cap. Mid-recording a
    /// user should not have to convert either.
    static func capWarning(secondsLeft: Int) -> String {
        let minutes = Int((Double(secondsLeft) / 60).rounded(.up))
        let left = minutes <= 1 ? "Less than a minute" : "About \(minutes) minutes"
        return "\(left) left — recording stops automatically at 2 hours"
    }

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onNoteCreated: (String?) -> Void

    @State private var pulse = false
    @State private var isStopping = false
    /// The finished recording, held while the user names it. Nothing is
    /// uploaded until they confirm — but the file is already durable on disk
    /// with its sidecar, so abandoning the sheet loses no audio.
    @State private var pendingSave: RecorderService.StopResult?

    private var elapsed: Int { env.recorder.elapsedSeconds }
    private var remainingWarning: Bool { elapsed >= RecorderService.warnAfterSeconds }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Button {
                    stopAndUpload()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.body)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Stop recording and go back")
                Spacer()
                Text("Recording…")
                    .font(Typography.label(15))
                    .foregroundStyle(Theme.muted)
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 12)

            Spacer()

            // Pulsing rings + mic
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    // Sub-expressions pre-typed into locals: the fully-inline
                    // modifier chain mixes Double/CGFloat/Int and took ~2s to
                    // type-check (an error on Xcode 16.x / CI).
                    let ringOpacity: Double = 0.25 - Double(i) * 0.06
                    let ringSize = CGFloat(180 + i * 40)
                    let ringScale: CGFloat = pulse && !reduceMotion ? 1.1 + CGFloat(i) * 0.05 : 1
                    let ringAnimation: Animation? = reduceMotion ? nil :
                        .easeInOut(duration: 2.4 + Double(i) * 0.3)
                        .repeatForever(autoreverses: true)
                        .delay(Double(i) * 0.2)
                    Circle()
                        .strokeBorder(Color.white.opacity(ringOpacity), lineWidth: 1.5)
                        .frame(width: ringSize, height: ringSize)
                        .scaleEffect(ringScale)
                        .opacity(pulse && !reduceMotion ? 0.4 : 1)
                        .animation(ringAnimation, value: pulse)
                }
                Circle()
                    .fill(Theme.inverse)
                    .frame(width: 112, height: 112)
                    .shadow(color: .white.opacity(0.15), radius: 30)
                    .overlay(
                        Image(systemName: "mic.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(Theme.onInverse)
                    )
            }
            .padding(.bottom, 36)
            .accessibilityHidden(true)

            // Timer
            Text(formatTimer(seconds: elapsed))
                .font(Typography.timer(45))
                .kerning(3.6)
                .foregroundStyle(Theme.heading)
                .monospacedDigit()
                .accessibilityLabel("Recording time")
                .accessibilityValue(formatTimer(seconds: elapsed))

            Text("Recording in progress")
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .padding(.top, 4)

            // Warning pill shown 5 minutes before the hard cap
            if remainingWarning {
                Text(Self.capWarning(secondsLeft: max(0, RecorderService.maxRecordingSeconds - elapsed)))
                    .font(Typography.label(13))
                    .foregroundStyle(Theme.heading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(
                        Capsule()
                            .fill(Theme.surface)
                            .overlay(Capsule().strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
                    )
                    .padding(.top, 12)
                    .accessibilityAddTraits(.updatesFrequently)
            }

            if let notice = env.recorder.notice {
                Text(notice)
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .padding(.top, 10)
                    .transition(.opacity)
            }

            WaveformView(level: env.recorder.level)
                .frame(width: min(360, UIScreen.main.bounds.width * 0.8), height: 64)
                .padding(.top, 24)
                .accessibilityHidden(true)

            Spacer()

            // Stop button
            Button {
                stopAndUpload()
            } label: {
                VStack(spacing: 10) {
                    // Shape says "stop": black square glyph on a white disc.
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Theme.onInverse)
                        .frame(width: 28, height: 28)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(Theme.inverse))
                    Text("End")
                        .font(Typography.label(14))
                        .foregroundStyle(Theme.body)
                }
            }
            .disabled(isStopping)
            .accessibilityLabel("End recording")
            .padding(.bottom, 48)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.recordingBackground.ignoresSafeArea())
        .task { await startRecording() }
        .onChange(of: env.recorder.autoStopped) { _, autoStop in
            // The service has already stopped and finalised the file — this
            // only presents the outcome. It used to call stopAndUpload() here,
            // which meant the stop never happened at all if the app was
            // backgrounded when the cap was reached.
            guard let autoStop, !isStopping else { return }
            isStopping = true
            env.alertMessage = autoStop.message
            if let result = autoStop.result {
                pendingSave = result
                isStopping = false
            } else {
                dismiss()
            }
        }
        .onChange(of: env.recorder.recordingError) { _, error in
            guard let error else { return }
            // Salvage rather than discard. An encode failure — the phone
            // filling up is the common one — used to delete the file
            // unconditionally, so a user 55 minutes into a recording lost
            // all 55 minutes. AAC is decodable up to the point it stopped, so
            // whatever was captured is worth keeping and uploading.
            //
            // Only discard when there is genuinely nothing there, which is the
            // case when the failure happened before any audio was written.
            if let salvaged = env.recorder.salvageCurrentFile() {
                env.alertMessage = "Recording stopped early: \(error) "
                    + "We've kept what was recorded so far — save it on the next screen."
                pendingSave = salvaged
            } else {
                env.alertMessage = "Recording stopped: \(error). Please try again."
                env.recorder.deleteCurrentFile()
                dismiss()
            }
        }
        .onAppear { pulse = true }
        .interactiveDismissDisabled()
        .sensoryFeedback(.impact(weight: .medium), trigger: env.recorder.isRecording)
        .sheet(item: $pendingSave) { result in
            NoteNameSheet(
                title: "Save",
                prompt: "Name this recording so you can find it later.",
                initialName: AppEnvironment.defaultRecordingName(),
                confirmLabel: "Save"
            ) { name in
                upload(result, title: name)
                return true
            }
            .algoMinutesSheet([.medium])
            .interactiveDismissDisabled()
        }
    }

    private func startRecording() async {
        do {
            try await env.startRecordingCapture()
        } catch {
            env.alertMessage = (error as? LocalizedError)?.errorDescription ?? "Could not start recording."
            dismiss()
        }
    }

    private func stopAndUpload() {
        guard !isStopping else { return }
        isStopping = true

        guard let result = env.recorder.stop() else {
            dismiss()
            return
        }
        // The recorder flagged the file as not having finished cleanly. That is
        // NOT a reason to delete it: AVAudioRecorder writes AAC progressively,
        // so everything captured before the failure is still there. This path
        // used to delete unconditionally, which is the same 55-minutes-lost bug
        // the encode-error handler above was written to fix — it just reached
        // the file down a different branch.
        //
        // Same for size: `> 0` is the weaker check that `minSalvageBytes`
        // exists to replace, because an AAC container always has header bytes.
        // Both cases now ask salvage, and salvage decides.
        guard !result.recordingFailed, result.sizeBytes >= RecorderService.minSalvageBytes else {
            if let salvaged = env.recorder.salvageCurrentFile() {
                env.alertMessage = "That recording didn't finish cleanly, but we've kept "
                    + "what was captured — save it on the next screen."
                pendingSave = salvaged
                isStopping = false
            } else {
                env.alertMessage = "No audio was captured. Please try again."
                env.recorder.deleteCurrentFile()
                dismiss()
            }
            return
        }

        // Name it before uploading. The recording is already durable on disk
        // with its sidecar, so this is a naming step, not a risk window.
        pendingSave = result
        isStopping = false
    }

    private func upload(_ result: RecorderService.StopResult, title: String) {
        pendingSave = nil
        // Dismiss from inside onNoteCreated, not here. Dismissing this cover
        // re-fires HomeView.onAppear -> checkForOrphan(), and until the sidecar
        // is written the file being uploaded still looks like an orphan — so
        // dismissing first opened a window where the user was offered
        // "Delete" for a live upload. uploadAndProcess calls associate()
        // immediately before onNoteCreated with no suspension between them, so
        // by the time we dismiss the association is on disk.
        Task {
            // Do NOT delete the file here — `uploadAndProcess` keeps it on
            // failure (for retry) and removes it only after a confirmed upload.
            await env.uploadAndProcess(
                fileURL: result.fileURL,
                mimeType: "audio/mp4",
                ext: "m4a",
                type: .recording,
                kind: .recording,
                durationSeconds: result.durationSeconds,
                title: title,
                onNoteCreated: { noteId in
                    dismiss()
                    onNoteCreated(noteId)
                }
            )
        }
    }
}

/// Live mic-level waveform — TimelineView + Canvas, no dependencies.
struct WaveformView: View {
    let level: Float
    @State private var history: [Float] = Array(repeating: 0, count: 48)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { _ in
            Canvas { context, size in
                let bars = history
                let barWidth = size.width / CGFloat(bars.count)
                for (index, value) in bars.enumerated() {
                    let height = max(3, CGFloat(value) * size.height)
                    let x = CGFloat(index) * barWidth
                    let rect = CGRect(
                        x: x + barWidth * 0.2,
                        y: (size.height - height) / 2,
                        width: barWidth * 0.6,
                        height: height
                    )
                    let opacity = 0.35 + Double(index) / Double(bars.count) * 0.65
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: barWidth * 0.3),
                        with: .color(Color.white.opacity(opacity))
                    )
                }
            }
            .onChange(of: level) { _, newLevel in
                history.removeFirst()
                history.append(newLevel)
            }
        }
    }
}
