import SwiftUI

/// Every recording still on this device that has not confirmed an upload.
///
/// Nothing listed these. `checkForOrphan()` surfaced `.first { noteId == nil }`
/// and only from `onAppear`, so a second unfinished recording was invisible —
/// and an upload that failed and never retried had no surface at all. The bytes
/// were safe on disk and the user had no way to see them, which for a
/// recording is indistinguishable from having lost it.
///
/// Deliberately plain. This is a safety net, not a feature.
struct PendingRecordingsView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    let onNoteOpened: (String) -> Void

    @State private var pending: [RecordingStore.PendingRecording] = []
    @State private var damaged: Set<String> = []
    @State private var checking = true
    @State private var busy: String?
    @State private var pendingDeletion: RecordingStore.PendingRecording?

    var body: some View {
        NavigationStack {
            Group {
                if checking {
                    ProgressView().tint(Theme.heading)
                } else if pending.isEmpty {
                    empty
                } else {
                    list
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Not yet uploaded")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await refresh() }
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
                    pending.removeAll { $0.id == doomed.id }
                }
                pendingDeletion = nil
            }
        } message: {
            Text("This permanently deletes the recording from this device. It has not been uploaded, so there is no other copy.")
        }
    }

    private var empty: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("Everything is uploaded")
                .font(Typography.headline())
                .foregroundStyle(Theme.heading)
            Text("Recordings appear here until their upload is confirmed.")
                .font(Typography.body(13))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .padding(Theme.Spacing.xxl)
    }

    private var list: some View {
        List {
            ForEach(pending) { item in
                row(item)
                    .listRowBackground(Theme.surface)
            }
        } .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func row(_ item: RecordingStore.PendingRecording) -> some View {
        let isDamaged = damaged.contains(item.fileName)
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(item.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(Typography.headline())
                    .foregroundStyle(Theme.heading)
                stateBadge(item, isDamaged: isDamaged)
            }
            Text(subtitle(item, isDamaged: isDamaged))
                .font(Typography.body(12))
                .foregroundStyle(isDamaged ? Theme.outline : Theme.muted)

            HStack(spacing: Theme.Spacing.md) {
                if busy == item.fileName {
                    ProgressView().tint(Theme.heading)
                } else if !isDamaged {
                    // A failed upload gets an explicit "Retry"; a never-attempted
                    // one gets "Upload". Both route through recoverRecording.
                    Button(item.state == .failed ? "Retry" : "Upload") {
                        Task { await upload(item) }
                    }
                    .font(Typography.body(13))
                }
                Spacer()
                // Never a one-tap delete, and never offered as the easy way out
                // of a damaged file — those bytes may be the only record of a
                // visit, and an offline recovery attempt is still possible.
                Button("Delete", role: .destructive) { pendingDeletion = item }
                    .font(Typography.body(13))
            }
            .padding(.top, Theme.Spacing.xs)
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    private func subtitle(_ item: RecordingStore.PendingRecording, isDamaged: Bool) -> String {
        if isDamaged { return "Damaged — can't be played or uploaded. Please get in touch." }
        if let noteId = item.noteId, env.uploadProgress[noteId] != nil {
            return "Uploading \(env.uploadProgress[noteId] ?? 0)%"
        }
        // A persisted failure explains itself in the user's words rather than
        // leaving them to guess why the item is still here.
        if item.state == .failed, let lastError = item.lastError, !lastError.isEmpty {
            return lastError
        }
        if let seconds = item.durationSeconds, seconds > 0 {
            let minutes = max(1, Int((Double(seconds) / 60).rounded()))
            return "About \(minutes) minute\(minutes == 1 ? "" : "s") · waiting to upload"
        }
        return "Waiting to upload"
    }

    /// Durable upload-lifecycle badge (A7.1). Hidden for the common "recorded,
    /// waiting" case — the subtitle already says that — so the badge only draws
    /// when it carries new information.
    @ViewBuilder
    private func stateBadge(_ item: RecordingStore.PendingRecording, isDamaged: Bool) -> some View {
        if let label = badgeLabel(item, isDamaged: isDamaged) {
            Text(label.text)
                .font(Typography.label(10))
                .kerning(0.8)
                .foregroundStyle(label.tint)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 2)
                .background(Capsule().fill(label.tint.opacity(0.14)))
        }
    }

    private func badgeLabel(
        _ item: RecordingStore.PendingRecording, isDamaged: Bool
    ) -> (text: String, tint: Color)? {
        if isDamaged { return ("DAMAGED", Theme.outline) }
        // A live upload takes precedence over any stale persisted state.
        if let noteId = item.noteId, env.uploadProgress[noteId] != nil {
            return ("UPLOADING", Theme.heading)
        }
        switch item.state {
        case .recorded:   return nil
        case .uploading:  return ("UPLOADING", Theme.heading)
        case .processing: return ("PROCESSING", Theme.heading)
        case .ready:      return ("READY", Theme.heading)
        case .failed:     return ("FAILED", Theme.heading)
        }
    }

    private func refresh() async {
        checking = true
        let all = env.recordingStore.allPending()
        // Validate here too, so a damaged file is labelled rather than offered
        // an Upload button it would fail on.
        var bad: Set<String> = []
        for item in all {
            let verdict = await RecordingValidator.validate(env.recordingStore.audioURL(for: item))
            if !verdict.isPlayable { bad.insert(item.fileName) }
        }
        pending = all
        damaged = bad
        checking = false
    }

    private func upload(_ item: RecordingStore.PendingRecording) async {
        busy = item.fileName
        defer { busy = nil }
        await env.recoverRecording(item) { noteId in onNoteOpened(noteId) }
        await refresh()
    }
}
