import Foundation
import Network
import SwiftUI

/// Composition root: one instance per app, injected via `.environment`.
/// Views talk to services through this — they never import Firebase.
@Observable
@MainActor
final class AppEnvironment {
    let api: APIClient
    let auth: AuthService
    let notes: NotesRepository
    let uploads: UploadService
    let recorder: RecorderService
    let recordingStore: RecordingStore
    let audioSession: AudioSessionCoordinator
    let player: AudioPlayerService
    let transcripts: TranscriptRepository

    /// Upload progress (0-100) for the note currently uploading, keyed by id.
    var uploadProgress: [String: Int] = [:]

    private let pathMonitor = NWPathMonitor()
    private let pathMonitorQueue = DispatchQueue(label: "algominutes.network-watch")

    /// Global user-facing alert (parity with the web `alert(...)` calls).
    var alertMessage: String?

    /// Guards against a double-fired retry for the same note.
    private var retryInFlight = Set<String>()
    /// Guards against re-resuming an upload that is already being resumed.
    private var resumeInFlight = Set<String>()

    init() {
        let api = APIClient()
        self.api = api
        self.auth = AuthService()
        self.notes = NotesRepository(api: api)
        self.uploads = UploadService()
        let store = RecordingStore()
        self.recordingStore = store
        self.recorder = RecorderService(store: store)
        let session = AudioSessionCoordinator()
        self.audioSession = session
        self.player = AudioPlayerService(session: session, store: store)
        self.transcripts = TranscriptRepository(api: api)
        startNetworkWatch()
    }

    /// Retry pending uploads the moment the network comes back.
    ///
    /// `resumePendingUploads` previously ran only on launch and on foreground.
    /// A user whose upload failed on dead office wifi, and who stayed in the
    /// app while it recovered, sat there with a recording on disk and
    /// nothing retrying it — the recording was safe but stuck until they
    /// happened to background and foreground the app.
    private func startNetworkWatch() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                guard let self, self.auth.workspaceId != nil else { return }
                AppLog.info("network_available_resuming_uploads")
                await self.resumePendingUploads()
            }
        }
        pathMonitor.start(queue: pathMonitorQueue)
    }

    /// Rename a note.
    ///
    /// Routed through `/api/update-note` rather than a direct Firestore write.
    /// Postgres is the system of record: a title written only to the cache
    /// leaves `/api/search` and `/api/chat` serving the old one, and the next
    /// reprocess would silently restore it. The endpoint writes Postgres first
    /// and mirrors to Firestore, so the live listener updates the UI.
    ///
    /// Returns false and raises the standard alert on failure, so the caller
    /// can keep the sheet open rather than pretending the rename landed.
    @discardableResult
    func renameNote(noteId: String, to title: String) async -> Bool {
        guard let wsId = auth.workspaceId else { return false }
        do {
            try await api.updateNote(noteId: noteId, workspaceId: wsId, title: title)
            return true
        } catch {
            AppLog.error("rename_note_failed: \(error)")
            alertMessage = "Couldn't rename this note. Please try again."
            return false
        }
    }

    /// Start a recording, handing the audio session over from playback first.
    ///
    /// Every recording start goes through here rather than calling
    /// `recorder.start()` directly. Reconfiguring the shared AVAudioSession
    /// underneath a playing AVPlayer is what produces a recording that
    /// silently captures nothing, and losing a recording is
    /// unrecoverable in a way that interrupted playback is not.
    func startRecordingCapture() async throws {
        audioSession.yieldToRecorder { [player] in player.suspendForRecording() }
        do {
            try await recorder.start()
        } catch {
            // The recorder never took the session; let playback claim it again.
            audioSession.recorderFinished()
            throw error
        }
        // Only now — the microphone prompt has resolved, so the two never stack,
        // and the request lands at the one moment its purpose is obvious. Asking
        // at launch gets denied, and iOS only ever asks once.
        Task { await RecordingNotifier.requestAuthorizationIfNeeded() }
    }

    func startSession() {
        guard let user = auth.user, let wsId = auth.workspaceId else { return }
        notes.start(uid: user.uid, workspaceId: wsId)
        Task { await resumePendingUploads() }
    }

    func endSession() {
        notes.stop()
    }

    /// Recordings that would be destroyed by signing out.
    ///
    /// Sign-out clears on-device recordings for privacy on a shared device,
    /// which is right — but it used to do so unconditionally, so a user
    /// whose upload had failed lost the recording permanently with no warning.
    /// The caller shows this count and asks first.
    var pendingRecordingsAtRisk: Int {
        recordingStore.allPending().count
    }

    /// Full sign-out: drop per-session UI state and this user's on-device
    /// recordings (privacy on shared devices), then sign out of Firebase/Google.
    /// `endSession()` runs via RootView's auth observer once the user clears.
    ///
    /// Destroys any recording that has not finished uploading, which is why
    /// SettingsView warns when `pendingRecordingsAtRisk > 0`. Deleting audio a
    /// user believes is safe is not something to do silently, even for a good
    /// privacy reason.
    func signOut() {
        uploadProgress.removeAll()
        retryInFlight.removeAll()
        resumeInFlight.removeAll()
        let pending = recordingStore.allPending()
        if !pending.isEmpty {
            AppLog.error("sign_out_discarding_pending count=\(pending.count)")
        }
        for item in pending {
            recordingStore.remove(fileName: item.fileName)
        }
        auth.signOut()
    }

    /// Resume any recording whose upload never confirmed — a Firebase Storage
    /// `putFile` cannot run in a background `URLSession`, so an upload that is
    /// interrupted by backgrounding/termination dies. The bytes still live on
    /// disk (PR-i1), associated with their note, so we re-upload from disk on
    /// the next launch and every foreground. This is what makes uploads survive
    /// backgrounding: they resume transparently rather than leaving a note
    /// stuck in `processing` forever.
    func resumePendingUploads() async {
        guard auth.workspaceId != nil else { return }
        // Snapshot up front — `reupload` mutates the store as it removes files.
        let resumable = recordingStore.allPending().filter { $0.noteId != nil }
        for pending in resumable {
            guard let noteId = pending.noteId else { continue }
            // Skip anything already uploading (live capture flow), retrying, or
            // mid-resume.
            guard uploadProgress[noteId] == nil,
                  !retryInFlight.contains(noteId),
                  !resumeInFlight.contains(noteId) else { continue }
            resumeInFlight.insert(noteId)
            AppLog.info("resuming_pending_upload noteId=\(noteId)")
            _ = await reupload(noteId: noteId, type: .recording, pending: pending, retryAttempt: nil)
            resumeInFlight.remove(noteId)
        }
    }

    // MARK: - Capture orchestration (parity with uploadAndProcess in App.tsx)

    /// Creates the note doc, uploads the file, and kicks off processing.
    /// Returns the noteId immediately after doc creation via `onNoteCreated`
    /// so callers can navigate to the detail view while the upload runs.
    func uploadAndProcess(
        fileURL: URL,
        mimeType: String,
        ext: String,
        type: NoteType,
        kind: StorageKind,
        durationSeconds: Int?,
        title: String? = nil,
        initialStatus: NoteStatus = .processing,
        onNoteCreated: @MainActor (String) -> Void = { _ in }
    ) async {
        guard let wsId = auth.workspaceId else { return }

        let dateStamp = Self.dateStamp()
        let placeholder = title ?? (type == .recording ? "Session_\(dateStamp)" : "Import_\(dateStamp)")

        let noteId: String
        do {
            var fields: [String: Any] = [
                "title": placeholder,
                "status": initialStatus.rawValue,
                "type": type.rawValue,
                "mimeType": mimeType,
            ]
            if let durationSeconds { fields["duration"] = durationSeconds }
            noteId = try notes.createNote(fields: fields)
        } catch {
            alertMessage = "Could not create the note. Please try again."
            return
        }

        let storagePath = StoragePaths.path(kind: kind, workspaceId: wsId, noteId: noteId, ext: ext)
        notes.updateNote(id: noteId, fields: ["storagePath": storagePath])

        // Durably link the on-disk recording to this note BEFORE uploading, so a
        // failed or interrupted upload can be re-uploaded into the same note
        // rather than lost. Only recordings live in the store; imports/scans are
        // picked files owned by the OS.
        if kind == .recording {
            recordingStore.associate(
                fileURL: fileURL, noteId: noteId, mimeType: mimeType, ext: ext, durationSeconds: durationSeconds
            )
        }
        onNoteCreated(noteId)

        uploadProgress[noteId] = 0
        defer { uploadProgress[noteId] = nil }

        do {
            try await uploads.upload(
                fileURL: fileURL,
                to: storagePath,
                contentType: mimeType,
                kind: kind,
                applyTimeout: kind == .recording,
                onProgress: { [weak self] percent in
                    self?.uploadProgress[noteId] = percent
                }
            )
        } catch {
            // Keep the local recording — it is associated with `noteId` and the
            // user can retry, which re-uploads from disk.
            let message = (error as? UploadError)?.errorDescription ?? UploadError.failed.errorDescription!
            notes.markNoteError(id: noteId, message: message)
            alertMessage = message
            return
        }

        // Upload confirmed — the bytes are safely in Storage, so the local copy
        // is no longer the only copy and can go.
        if kind == .recording {
            recordingStore.remove(fileURL: fileURL)
        }

        do {
            try await api.processAudio(.init(
                noteId: noteId,
                workspaceId: wsId,
                type: type,
                storagePath: storagePath,
                mimeType: mimeType
            ))
        } catch {
            AppLog.error("process_kickoff_failed: \(error.localizedDescription)")
            let message = type == .importAudio
                ? "Could not queue your file. Please try again."
                : "Could not start processing. Please try again."
            notes.markNoteError(id: noteId, message: message)
        }
    }

    // MARK: - Retry / recovery (durable re-upload from disk)

    /// Retry a failed note. When we still hold the original recording on disk
    /// (the upload never confirmed), re-upload it before asking the backend to
    /// reprocess — the stored `storagePath` may point at bytes that were never
    /// written. Otherwise fall back to the storage-path retry.
    @discardableResult
    func retry(note: Note) async -> NotesRepository.RetryOutcome {
        if note.type == .recording,
           let pending = recordingStore.pendingRecording(forNoteId: note.id),
           FileManager.default.fileExists(atPath: recordingStore.audioURL(for: pending).path) {
            guard !retryInFlight.contains(note.id) else { return .queued }
            let attempts = note.retryAttempt ?? 0
            guard attempts < NotesRepository.maxRetryAttempts else {
                return .blocked(message: "We've already tried this \(attempts) times. Please try uploading the file directly, or contact support if the problem persists.")
            }
            retryInFlight.insert(note.id)
            defer { retryInFlight.remove(note.id) }
            return await reupload(noteId: note.id, type: .recording, pending: pending, retryAttempt: attempts + 1)
        }
        return await notes.retryProcessing(note: note)
    }

    /// Recover an unfinished recording found on launch. If it is still linked to
    /// a live note, re-upload into that note (never a duplicate); otherwise the
    /// app died before any note existed, so create a fresh one.
    func recoverRecording(_ pending: RecordingStore.PendingRecording, onNoteCreated: @MainActor (String) -> Void = { _ in }) async {
        let fileURL = recordingStore.audioURL(for: pending)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            recordingStore.remove(fileName: pending.fileName)
            return
        }
        // Everything recovered from disk goes through here, so this is the one
        // place that has to prove the file is actually playable. A recording the
        // app never finalised has no moov atom: it is not transcribable, and
        // uploading it would look like success while losing the recording.
        //
        // Never delete on this path. The file may be the only record of a
        // meeting, and a few tens of megabytes is a cheap price for
        // keeping an offline recovery attempt possible.
        let verdict = await RecordingValidator.validate(fileURL)
        guard verdict.isPlayable else {
            AppLog.error("recording_recovery_rejected file=\(pending.fileName)")
            alertMessage = RecordingValidator.damagedMessage
            return
        }

        if let noteId = pending.noteId {
            onNoteCreated(noteId)
            _ = await reupload(noteId: noteId, type: .recording, pending: pending, retryAttempt: nil)
        } else {
            await uploadAndProcess(
                fileURL: fileURL,
                mimeType: pending.mimeType,
                ext: pending.ext,
                type: .recording,
                kind: .recording,
                // The sidecar is missing for a file the app died before
                // associating, so its duration is nil — and a nil duration makes
                // StuckBudgets fall back to a flat 480s budget, which flips a
                // legitimately-transcribing 90-minute recording to error at eight
                // minutes. The validator just measured the real length, so use it.
                durationSeconds: pending.durationSeconds ?? verdict.durationSeconds,
                onNoteCreated: onNoteCreated
            )
        }
    }

    /// Shared core: re-upload a stored recording from disk into an existing note,
    /// then kick off processing. Removes the local file only on confirmed upload.
    private func reupload(
        noteId: String, type: NoteType, pending: RecordingStore.PendingRecording, retryAttempt: Int?
    ) async -> NotesRepository.RetryOutcome {
        guard let wsId = auth.workspaceId else { return .blocked(message: "Not signed in") }
        let fileURL = recordingStore.audioURL(for: pending)
        let storagePath = StoragePaths.path(kind: .recording, workspaceId: wsId, noteId: noteId, ext: pending.ext)

        // Re-arm the stuck watchdog — the note is going back in-progress.
        notes.resetStuckGuard(noteId: noteId)

        var fields: [String: Any] = [
            "status": NoteStatus.queued.rawValue,
            "errorMessage": NSNull(),
            "storagePath": storagePath,
        ]
        if let retryAttempt { fields["retryAttempt"] = retryAttempt }
        notes.updateNote(id: noteId, fields: fields)

        uploadProgress[noteId] = 0
        defer { uploadProgress[noteId] = nil }

        do {
            try await uploads.upload(
                fileURL: fileURL,
                to: storagePath,
                contentType: pending.mimeType,
                kind: .recording,
                applyTimeout: true,
                onProgress: { [weak self] percent in self?.uploadProgress[noteId] = percent }
            )
        } catch {
            let message = (error as? UploadError)?.errorDescription ?? UploadError.failed.errorDescription!
            notes.markNoteError(id: noteId, message: message)
            return .blocked(message: message)
        }

        recordingStore.remove(fileName: pending.fileName)

        do {
            try await api.processAudio(.init(
                noteId: noteId, workspaceId: wsId, type: type,
                storagePath: storagePath, mimeType: pending.mimeType, retryAttempt: retryAttempt
            ))
            return .queued
        } catch {
            AppLog.error("reupload_process_kickoff_failed: \(error.localizedDescription)")
            notes.markNoteError(id: noteId, message: "Could not start processing. Please try again.")
            return .blocked(message: "Could not start processing. Please try again.")
        }
    }

    /// The name a recording gets if the user does not type one. Shared with
    /// the save sheet so its prefilled value and the fallback cannot drift —
    /// TitleDeriver.isPlaceholder matches this exact shape to decide whether
    /// an auto-generated title may be replaced by one derived from the gist.
    nonisolated static func defaultRecordingName(_ date: Date = Date()) -> String {
        "Session_\(dateStamp(date))"
    }

    nonisolated static func dateStamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: date)
    }
}
