import SwiftUI

enum CaptureAction: String, Identifiable, CaseIterable {
    case recording, importFiles, scanText

    var id: String { rawValue }

    var title: String {
        switch self {
        case .recording: return "Instant Recorder"
        case .importFiles: return "Import Files"
        case .scanText: return "Scan Text"
        }
    }

    var subtitle: String {
        switch self {
        case .recording: return "Record and generate a smart summary"
        case .importFiles: return "Import a file and summarize its contents"
        case .scanText: return "Extract text from images and documents"
        }
    }

    var chips: [String] {
        switch self {
        case .recording: return ["Meetings", "Lectures", "Interviews"]
        case .importFiles: return ["PDF", "Audio", "YouTube"]
        case .scanText: return ["Camera", "Images", "TXT"]
        }
    }

    var icon: String {
        switch self {
        case .recording: return "mic.fill"
        case .importFiles: return "square.and.arrow.down"
        case .scanText: return "doc.text.viewfinder"
        }
    }
}

struct HomeView: View {
    @Environment(AppEnvironment.self) private var env

    @State private var activeSheet: CaptureAction?
    @State private var recorderFlow = RecorderFlowState()
    @State private var selectedNoteId: String?
    @State private var orphanRecording: RecordingStore.PendingRecording?
    @State private var pendingDeletion: RecordingStore.PendingRecording?
    @State private var showPendingRecordings = false
    @State private var pendingCount = 0

    private var firstName: String {
        let name = env.auth.user?.displayName?.split(separator: " ").first.map(String.init)
        return name?.isEmpty == false ? name! : "there"
    }

    private var timeOfDayGreeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: return "GOOD MORNING"
        case 12..<17: return "GOOD AFTERNOON"
        default: return "GOOD EVENING"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
                    header
                        .appearFade(index: 0)
                    if pendingCount > 0 { pendingBanner }
                    captureActions
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.md)
                .padding(.bottom, Theme.Spacing.xxxl)
            }
            .background(OwllBackground())
            // Clean top edge: content scrolls under a short fade instead of
            // colliding with the status bar.
            .overlay(alignment: .top) {
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: 60)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
            }
            .refreshable { await env.notes.refresh() }
            .navigationDestination(item: $selectedNoteId) { noteId in
                NoteDetailView(noteId: noteId)
            }
        }
        .sheet(item: $activeSheet) { action in
            switch action {
            case .recording:
                RecorderConsentFlow(flow: $recorderFlow) { noteId in
                    activeSheet = nil
                    selectedNoteId = noteId
                }
                .wassupSheet([.medium])
            case .importFiles:
                ImportSheet { noteId in
                    activeSheet = nil
                    if let noteId { selectedNoteId = noteId }
                }
                .wassupSheet()
            case .scanText:
                ScanSheet { noteId in
                    activeSheet = nil
                    if let noteId { selectedNoteId = noteId }
                }
                .wassupSheet()
            }
        }
        .fullScreenCover(isPresented: $recorderFlow.isRecordingScreenPresented) {
            RecordingView { noteId in
                if let noteId { selectedNoteId = noteId }
            }
        }
        .onAppear { checkForOrphan(); refreshPendingCount() }
        .sheet(isPresented: $showPendingRecordings, onDismiss: refreshPendingCount) {
            PendingRecordingsView { noteId in
                showPendingRecordings = false
                selectedNoteId = noteId
            }
        }
        .alert(
            "Unfinished recording found",
            isPresented: Binding(
                get: { orphanRecording != nil },
                set: { if !$0 { orphanRecording = nil } }
            )
        ) {
            Button("Upload it") { recoverOrphan() }
            // "Later" is the safe default and must exist. This alert used to
            // offer only Upload and Delete, so a doctor who wanted neither had
            // no way out except destroying a consultation.
            Button("Later", role: .cancel) { orphanRecording = nil }
            Button("Delete", role: .destructive) {
                pendingDeletion = orphanRecording
                orphanRecording = nil
            }
        } message: {
            Text(orphanMessage)
        }
        // Deletion is unrecoverable and the audio may be the only copy of a
        // consultation, so it takes a second, explicit confirmation that names
        // what is about to be lost.
        .alert(
            "Delete this recording?",
            isPresented: Binding(
                get: { pendingDeletion != nil },
                set: { if !$0 { pendingDeletion = nil } }
            )
        ) {
            Button("Keep it", role: .cancel) { pendingDeletion = nil }
            Button("Delete", role: .destructive) {
                if let doomed = pendingDeletion {
                    env.recordingStore.remove(fileName: doomed.fileName)
                }
                pendingDeletion = nil
            }
        } message: {
            Text(deletionMessage)
        }
    }

    /// A standing, visible count of recordings that have not confirmed an
    /// upload. Without it the only signal was a one-shot alert for a single
    /// orphan, so a failed upload was silent and a second orphan invisible.
    private var pendingBanner: some View {
        Button { showPendingRecordings = true } label: {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
                    .foregroundStyle(Theme.heading)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(pendingCount) recording\(pendingCount == 1 ? "" : "s") not yet uploaded")
                        .font(Typography.headline())
                        .foregroundStyle(Theme.heading)
                    Text("Tap to review")
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.muted)
                }
                Spacer()
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surface)
                    .strokeBorder(Theme.outline.opacity(0.25), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func refreshPendingCount() {
        pendingCount = env.recordingStore.allPending().count
    }

    private var orphanMessage: String {
        guard let orphan = orphanRecording else { return "" }
        let when = orphan.createdAt.formatted(date: .abbreviated, time: .shortened)
        return "A recording from \(when) didn't finish uploading. Upload it now?"
    }

    private var deletionMessage: String {
        guard let doomed = pendingDeletion else { return "" }
        let when = doomed.createdAt.formatted(date: .abbreviated, time: .shortened)
        // Duration is unknown for recordings the app never got to finalise, so
        // the copy has to work without it rather than print "0 minutes".
        if let seconds = doomed.durationSeconds, seconds > 0 {
            let minutes = max(1, Int((Double(seconds) / 60).rounded()))
            return "The recording from \(when) is about \(minutes) minute\(minutes == 1 ? "" : "s") long and has not been uploaded. This permanently deletes it from this device."
        }
        return "The recording from \(when) has not been uploaded. This permanently deletes it from this device."
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(timeOfDayGreeting)
                .font(Typography.eyebrow())
                .tracking(1.4)
                .foregroundStyle(Theme.muted)
            Text(firstName)
                .font(Typography.display())
                .foregroundStyle(Theme.heading)
            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(Typography.body(13))
                .foregroundStyle(Theme.tertiary)
        }
        .padding(.top, Theme.Spacing.sm)
    }

    // MARK: - Capture actions (Owll-style stacked feature cards)

    private var captureActions: some View {
        VStack(spacing: Theme.Spacing.lg) {
            featureCard(.recording, style: .hero, index: 1)
            featureCard(.importFiles, style: .raised, index: 2)
            featureCard(.scanText, style: .raised, index: 3)
        }
    }

    private func featureCard(_ action: CaptureAction, style: OwllCardStyle, index: Int) -> some View {
        Button {
            activeSheet = action
        } label: {
            OwllCard(style: style) {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    HStack(alignment: .bottom, spacing: Theme.Spacing.lg) {
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            Text(action.title)
                                .font(Typography.heading(22))
                                .foregroundStyle(Theme.heading)
                            if action == .recording, env.recorder.isRecording {
                                HStack(spacing: Theme.Spacing.sm) {
                                    PulsingDot()
                                    Text(formatTimer(seconds: env.recorder.elapsedSeconds))
                                        .font(Typography.timer(14))
                                        .monospacedDigit()
                                        .foregroundStyle(Theme.heading)
                                }
                            } else {
                                Text(action.subtitle)
                                    .font(Typography.body(13))
                                    .foregroundStyle(Theme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            chipsRow(action.chips)
                                .padding(.top, Theme.Spacing.xs)
                        }
                        Spacer(minLength: Theme.Spacing.sm)
                        Image(systemName: action.icon)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Theme.onInverse)
                            .frame(width: 56, height: 56)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.Radius.md)
                                    .fill(Theme.inverse)
                                    .shadow(color: .black.opacity(0.4), radius: 10)
                            )
                    }
                    if action == .recording {
                        HeroWaveform()
                    }
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .appearFade(index: index)
        .accessibilityLabel("\(action.title). \(action.subtitle)")
    }

    private func chipsRow(_ chips: [String]) -> some View {
        // ViewThatFits keeps chips on one row at default type sizes and wraps
        // to a column at accessibility sizes instead of truncating.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.sm) { chipViews(chips) }
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) { chipViews(chips) }
        }
    }

    private func chipViews(_ chips: [String]) -> some View {
        ForEach(chips, id: \.self) { chip in
            Text(chip)
                .font(Typography.label(12))
                .foregroundStyle(Theme.outline)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 4)
                .background(Capsule().strokeBorder(Theme.outline.opacity(0.35), lineWidth: 1))
        }
    }

    private func checkForOrphan() {
        guard !env.recorder.isRecording else { return }
        guard pendingDeletion == nil else { return }
        // Recordings still linked to a note resume automatically
        // (env.resumePendingUploads). Only prompt for genuine orphans — audio
        // captured before any note existed (app died mid-capture).
        //
        // The file the recorder is holding is excluded explicitly. Dismissing
        // the recording screen re-fires onAppear, and there is a window between
        // the note being created and the sidecar being written where the file
        // that is currently uploading still looks like an orphan. Offering it
        // here is how a doctor ends up tapping Delete on a live upload.
        let inFlight = env.recorder.currentFileURL?.lastPathComponent
        orphanRecording = env.recordingStore.allPending()
            .first { $0.noteId == nil && $0.fileName != inFlight }
    }

    private func recoverOrphan() {
        guard let orphan = orphanRecording else { return }
        orphanRecording = nil
        Task {
            await env.recoverRecording(orphan) { noteId in selectedNoteId = noteId }
        }
    }
}

// MARK: - Hero waveform (signature moment — the one thing animated at rest)

struct PulsingDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Theme.heading)
            .frame(width: 8, height: 8)
            .opacity(pulsing ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
    }
}

struct HeroWaveform: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let base: [CGFloat] = [0.35, 0.7, 1.0, 0.7, 0.35]

    var body: some View {
        if reduceMotion {
            bars(at: 0)
        } else {
            // 12fps is plenty for an idle breath and keeps CPU negligible.
            TimelineView(.animation(minimumInterval: 1 / 12)) { context in
                bars(at: context.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func bars(at t: TimeInterval) -> some View {
        HStack(spacing: 5) {
            ForEach(0..<5, id: \.self) { i in
                let wobble = reduceMotion ? 0 : sin(t * 2 + Double(i) * 1.1) * 3
                Capsule()
                    .fill(Theme.outline.opacity(0.7))
                    .frame(width: 3, height: 8 + Self.base[i] * 12 + wobble)
            }
        }
        .frame(height: 26, alignment: .center)
        .accessibilityHidden(true)
    }
}
