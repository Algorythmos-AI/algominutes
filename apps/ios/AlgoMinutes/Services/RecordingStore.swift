import Foundation

/// Per-recording upload lifecycle the CLIENT tracks locally (survives app kill /
/// reboot), mirroring `RecordingState` in
/// `packages/contracts/src/schemas/async.ts`. Distinct from the server-side
/// `NoteStatus` pipeline detail:
///   recorded   = on disk, not yet uploaded
///   uploading  = resumable upload in flight (see BackgroundUploadService / putFile)
///   processing = uploaded; server pipeline running (queued→…→summarizing)
///   ready | failed = terminal
enum RecordingState: String, Codable, Equatable, Sendable {
    case recorded, uploading, processing, ready, failed
}

/// Durable registry of on-disk recordings and their note association.
///
/// Recordings live in `Application Support/recordings/` — NOT
/// `temporaryDirectory`, which iOS can purge under storage pressure and which
/// the old code wiped on every `start()`. Each audio file gets a sibling
/// `<name>.json` sidecar carrying the note id + upload metadata, written
/// *before* the upload begins. That association is what lets a recording whose
/// upload fails or is interrupted survive an app kill and be re-uploaded into
/// its original note instead of being silently lost.
///
/// Lifecycle:
///   1. `makeRecordingURL()`      — recorder writes AAC audio here (no sidecar yet)
///   2. `associate(...)`          — note doc created → sidecar written (durable link)
///   3a. upload confirmed         → `remove(...)` deletes audio + sidecar
///   3b. upload fails / app killed → audio + sidecar remain; recovered on next launch
/// The recorder's file format: AAC in an ADTS stream (`.aac`).
///
/// ADTS is a sequence of self-contained frames with nothing written at the
/// end, so a recording the app never got to stop (a crash, a jetsam kill, the
/// phone dying) stays decodable up to its last whole frame. An `.m4a` needs its
/// `moov` atom, written only by `stop()`; without it the file is unreadable and
/// the whole meeting is lost. (Measured on a file cut at 60%: ADTS decoded all
/// 72.0 s in ffmpeg, AVAudioFile and AVAsset; the same audio as .m4a opened in
/// none of them.) Recordings from older builds are still `.m4a`.
enum RecordingFormat {
    static let ext = "aac"
    static let mimeType = "audio/aac"

    static func mimeType(forExt ext: String) -> String {
        ext.lowercased() == "aac" ? "audio/aac" : "audio/mp4"
    }

    /// The extensions a recording on disk may have (current, then older builds').
    static let recordedExts: Set<String> = ["aac", "m4a"]
}

@MainActor
final class RecordingStore {
    struct PendingRecording: Codable, Equatable, Identifiable {
        var recordingId: String
        var fileName: String
        var mimeType: String
        var ext: String
        var durationSeconds: Int?
        /// Set once the note doc exists. `nil` means the app died before a note
        /// was ever created — recovery must create a fresh note for it.
        var noteId: String?
        var createdAt: Date

        // A7.1 — durable upload lifecycle. Defaulted so both the memberwise
        // initializer (existing call sites) and old sidecars written before A7
        // (no such keys — see the custom `init(from:)` below) keep working.
        var state: RecordingState = .recorded
        /// Bytes already accepted by the resumable session, persisted so a
        /// background upload resumes from the offset after a reboot (A7.2).
        var uploadedBytes: Int64?
        /// Last upload/processing failure, shown on the pending-recordings badge.
        var lastError: String?
        /// The resumable session this recording's upload is using (POST /v1/uploads):
        /// a retry continues it from the server's byte count instead of starting over.
        var uploadId: String?
        var uploadSessionUri: String?

        var id: String { recordingId }
        var isAssociated: Bool { noteId != nil }
    }

    /// Internal rather than private: RecorderService checks free space on this
    /// volume before starting, so it needs to know which volume that is.
    let directory: URL
    private let fileManager: FileManager

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.directory = directory ?? Self.defaultDirectory(fileManager: fileManager)
        ensureDirectory()
    }

    // MARK: - Directory

    static func defaultDirectory(fileManager: FileManager = .default) -> URL {
        let base = (try? fileManager.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )) ?? fileManager.temporaryDirectory
        return base.appendingPathComponent("recordings", isDirectory: true)
    }

    private func ensureDirectory() {
        if !fileManager.fileExists(atPath: directory.path) {
            do {
                try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            } catch {
                AppLog.error("recording_dir_create_failed: \(error.localizedDescription)")
                return
            }
        }
        // Recordings are transient capture data, not user documents — keep them
        // out of iCloud/iTunes backup.
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    // MARK: - File lifecycle

    /// Allocates a fresh audio-file URL for a new recording. The file is created
    /// by the recorder; the sidecar is written later by `associate`.
    func makeRecordingURL(ext: String = RecordingFormat.ext) -> URL {
        directory.appendingPathComponent("recording_\(UUID().uuidString).\(ext)")
    }

    func audioURL(for recording: PendingRecording) -> URL {
        directory.appendingPathComponent(recording.fileName)
    }

    /// Durably links an on-disk recording to the note it belongs to, *before*
    /// the upload starts, so a failed/interrupted upload can be retried into the
    /// same note.
    func associate(fileURL: URL, noteId: String, mimeType: String, ext: String, durationSeconds: Int?) {
        let fileName = fileURL.lastPathComponent
        write(PendingRecording(
            recordingId: recordingId(fromFileName: fileName),
            fileName: fileName,
            mimeType: mimeType,
            ext: ext,
            durationSeconds: durationSeconds,
            noteId: noteId,
            createdAt: Date()
        ))
    }

    func write(_ recording: PendingRecording) {
        do {
            let data = try JSONEncoder().encode(recording)
            try data.write(to: sidecarURL(forFileName: recording.fileName), options: .atomic)
        } catch {
            AppLog.error("recording_sidecar_write_failed: \(error.localizedDescription)")
        }
    }

    /// Deletes the audio file and its sidecar — called after a confirmed upload
    /// or when the user discards a recording.
    func remove(fileName: String) {
        try? fileManager.removeItem(at: directory.appendingPathComponent(fileName))
        try? fileManager.removeItem(at: sidecarURL(forFileName: fileName))
    }

    func remove(fileURL: URL) {
        remove(fileName: fileURL.lastPathComponent)
    }

    /// Removes the recording still waiting on this device for a note, if any
    /// (the note was deleted). Returns whether there was one.
    @discardableResult
    func removeRecording(forNoteId noteId: String) -> Bool {
        guard let pending = pendingRecording(forNoteId: noteId) else { return false }
        remove(fileName: pending.fileName)
        return true
    }

    // MARK: - Upload state (A7.1 / A7.2)

    /// Read the sidecar for a specific file, if one exists. Callers mutate the
    /// returned value and pass it back to `write(_:)`.
    func pendingRecording(forFileName fileName: String) -> PendingRecording? {
        readSidecar(forFileName: fileName)
    }

    /// Durably record an upload-lifecycle transition on the sidecar. No-op for a
    /// file that has no sidecar yet (an orphan captured before association) —
    /// there is nothing to annotate until `associate(...)` writes one.
    ///
    /// `uploadedBytes`/`lastError` are only touched when provided, so a plain
    /// state flip does not clobber a persisted resume offset.
    func setUploadState(
        fileName: String,
        state: RecordingState,
        uploadedBytes: Int64? = nil,
        lastError: String?? = .none
    ) {
        guard var recording = readSidecar(forFileName: fileName) else { return }
        recording.state = state
        if let uploadedBytes { recording.uploadedBytes = uploadedBytes }
        if case let .some(err) = lastError { recording.lastError = err }
        write(recording)
    }

    /// Remember (or, with nils, forget) the upload session a recording is using.
    func setUploadSession(fileName: String, uploadId: String?, sessionUri: String?) {
        guard var recording = readSidecar(forFileName: fileName) else { return }
        recording.uploadId = uploadId
        recording.uploadSessionUri = sessionUri
        write(recording)
    }

    // MARK: - Queries

    func pendingRecording(forNoteId noteId: String) -> PendingRecording? {
        allPending().first { $0.noteId == noteId }
    }

    /// Every non-empty recording still on disk: associated ones (sidecar
    /// present) and orphans (audio file with no sidecar — the app died before a
    /// note was created). Sorted oldest-first so recovery is deterministic.
    func allPending() -> [PendingRecording] {
        let contents = (try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]
        )) ?? []
        let audioFiles = contents.filter {
            RecordingFormat.recordedExts.contains($0.pathExtension.lowercased()) && $0.lastPathComponent.hasPrefix("recording_")
        }
        return audioFiles.compactMap { url -> PendingRecording? in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size > 0 else { return nil }
            if let recording = readSidecar(forFileName: url.lastPathComponent) {
                return recording
            }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            return PendingRecording(
                recordingId: recordingId(fromFileName: url.lastPathComponent),
                fileName: url.lastPathComponent,
                mimeType: RecordingFormat.mimeType(forExt: url.pathExtension),
                ext: url.pathExtension.lowercased(),
                durationSeconds: nil,
                noteId: nil,
                createdAt: modified
            )
        }
        .sorted { $0.createdAt < $1.createdAt }
    }

    // MARK: - Internals

    private func sidecarURL(forFileName fileName: String) -> URL {
        directory.appendingPathComponent(fileName).appendingPathExtension("json")
    }

    private func readSidecar(forFileName fileName: String) -> PendingRecording? {
        guard let data = try? Data(contentsOf: sidecarURL(forFileName: fileName)) else { return nil }
        return try? JSONDecoder().decode(PendingRecording.self, from: data)
    }

    /// `recording_<uuid>.m4a` → `<uuid>`.
    private func recordingId(fromFileName fileName: String) -> String {
        var name = fileName
        if let dot = name.firstIndex(of: ".") { name = String(name[..<dot]) }
        if name.hasPrefix("recording_") { name.removeFirst("recording_".count) }
        return name
    }
}

// MARK: - Backward-compatible decoding (A7.1)

extension RecordingStore.PendingRecording {
    /// Old sidecars written before A7 carry no `state`/`uploadedBytes`/`lastError`
    /// keys. Synthesised `Decodable` treats a missing key as an error and ignores
    /// property defaults, so decode the new fields with `decodeIfPresent` and fall
    /// back to `.recorded`. Living in an extension keeps the memberwise
    /// initializer available to existing call sites. Uses the default date
    /// strategy, matching the encoder in `write(_:)`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recordingId = try c.decode(String.self, forKey: .recordingId)
        fileName = try c.decode(String.self, forKey: .fileName)
        mimeType = try c.decode(String.self, forKey: .mimeType)
        ext = try c.decode(String.self, forKey: .ext)
        durationSeconds = try c.decodeIfPresent(Int.self, forKey: .durationSeconds)
        noteId = try c.decodeIfPresent(String.self, forKey: .noteId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        state = try c.decodeIfPresent(RecordingState.self, forKey: .state) ?? .recorded
        uploadedBytes = try c.decodeIfPresent(Int64.self, forKey: .uploadedBytes)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        uploadId = try c.decodeIfPresent(String.self, forKey: .uploadId)
        uploadSessionUri = try c.decodeIfPresent(String.self, forKey: .uploadSessionUri)
    }
}
