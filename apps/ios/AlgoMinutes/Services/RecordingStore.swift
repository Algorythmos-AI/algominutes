import Foundation

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
    func makeRecordingURL(ext: String = "m4a") -> URL {
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
            $0.pathExtension == "m4a" && $0.lastPathComponent.hasPrefix("recording_")
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
                mimeType: "audio/mp4",
                ext: "m4a",
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
