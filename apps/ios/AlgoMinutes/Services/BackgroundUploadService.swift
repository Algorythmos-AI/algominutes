import Foundation

/// A7.2 — resumable, reboot-surviving uploads over a `URLSession` **background**
/// configuration.
///
/// The only upload path (iOS PR-17 D). The api mints a GCS resumable session
/// for the note's object in its recordings bucket (POST /v1/uploads); the bytes
/// go straight to GCS; `complete` confirms them. The Firebase SDK upload wrote
/// to Firebase's default bucket, which the api never reads.
///
/// How it differs from the fallback:
///   - The transfer runs on a background `URLSession`, so it continues after the
///     app is suspended and is relaunched by the system to finish.
///   - Bytes go to the server-minted GCS resumable `sessionUri` in chunks, each
///     with a `Content-Range` header. GCS answers `308` while a session is
///     incomplete and `2xx` when the object is finalised.
///   - The accepted byte offset is persisted on the recording's sidecar
///     (`RecordingStore.setUploadState`) after every chunk, so a reboot resumes
///     from the offset (confirmed against `uploadSessionStatus`) rather than
///     restarting from byte 0 — the one thing the Firebase fallback cannot do.
///
/// Cross-launch note: the continuation bridge below only spans the current
/// process. If the app is killed mid-chunk, the persisted offset plus
/// `AppEnvironment.resumePendingUploads` re-drives this from the saved anchor on
/// the next launch.
@MainActor
final class BackgroundUploadService: NSObject {
    static let sessionIdentifier = "com.algorythmos.algominutes.upload"
    /// Set once so the AppDelegate can hand back the system's background-events
    /// completion handler after a background wake.
    static weak var shared: BackgroundUploadService?

    private static let maxChunkRetries = 4
    private static let minChunkBytes: Int64 = 256 * 1024

    /// Handed over by the AppDelegate's
    /// `handleEventsForBackgroundURLSession`; called once the session has
    /// flushed its queued delegate events.
    nonisolated(unsafe) var backgroundCompletionHandler: (() -> Void)?

    private let store: RecordingStore
    private let api: APIClient

    // Bridges each delegate-driven task back to its awaiting caller. Keyed by
    // task identifier and guarded by `lock` because the delegate fires on the
    // session's private queue, not the main actor.
    private let lock = NSLock()
    nonisolated(unsafe) private var continuations: [Int: CheckedContinuation<Void, Error>] = [:]

    init(store: RecordingStore, api: APIClient) {
        self.store = store
        self.api = api
        super.init()
        Self.shared = self
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        // A recording is worth finishing promptly; don't let the OS defer it.
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true
        // P1 Wi-Fi-only toggle, read live at session creation (A7.2).
        config.allowsCellularAccess = !UploadPreferences.wifiOnly
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    /// Upload a file into the note's object and return the object name the api
    /// recorded (pass it to /v1/process). `pending` is a recording's sidecar: its
    /// session is remembered, so a retry continues it from the server's byte
    /// count. Without one (an import, a file the OS owns) a failed upload starts
    /// over. Throws once retries are exhausted; the caller keeps the local file.
    func upload(
        fileURL: URL,
        noteId: String,
        workspaceId: String,
        fileName: String,
        contentType: String,
        pending: RecordingStore.PendingRecording?,
        onProgress: @escaping @MainActor (Int) -> Void
    ) async throws -> String {
        let total = Self.fileSize(fileURL)
        guard total > 0 else { throw UploadError.failed }
        // The server refuses it (413) before minting a session; say so without the round trip.
        guard total <= StorageKind.serverMaxBytes else {
            throw UploadError.tooLarge(limitLabel: StorageKind.serverMaxLabel, isRecording: pending != nil)
        }

        // A session's bytes only count within that session: continue the
        // recording's own session if the server still has it open, else start a
        // new one from byte 0 (never a new session from an old offset).
        var uploadId = pending?.uploadId
        var sessionUri = pending?.uploadSessionUri
        var offset: Int64 = 0
        var chunkSize = Self.minChunkBytes
        if let id = uploadId, sessionUri != nil,
           let status = try? await api.uploadSessionStatus(uploadId: id) {
            offset = status.complete ? total : min(status.receivedBytes, total)
        } else {
            let created = try await api.createUploadSession(
                noteId: noteId,
                workspaceId: workspaceId,
                fileName: fileName,
                contentType: contentType,
                totalBytes: total
            )
            uploadId = created.uploadId
            sessionUri = created.sessionUri
            chunkSize = max(Self.minChunkBytes, Int64(created.chunkSize))
            if let pending {
                store.setUploadSession(fileName: pending.fileName, uploadId: created.uploadId, sessionUri: created.sessionUri)
            }
        }
        guard let uploadId, let sessionUri else { throw UploadError.failed }
        if let pending {
            store.setUploadState(fileName: pending.fileName, state: .uploading, uploadedBytes: offset)
        }

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        while offset < total {
            let end = min(offset + chunkSize, total)
            try handle.seek(toOffset: UInt64(offset))
            let data = handle.readData(ofLength: Int(end - offset))
            try await putChunkWithBackoff(
                to: sessionUri, data: data, start: offset, end: end, total: total
            )
            offset = end
            if let pending {
                store.setUploadState(fileName: pending.fileName, state: .uploading, uploadedBytes: offset)
            }
            let percent = Int((Double(offset) / Double(total) * 100).rounded())
            onProgress(min(100, percent))
        }

        let done = try await api.completeUpload(uploadId: uploadId)
        if let pending {
            store.setUploadState(fileName: pending.fileName, state: .processing, uploadedBytes: offset)
            store.setUploadSession(fileName: pending.fileName, uploadId: nil, sessionUri: nil)
        }
        return done.storagePath
    }

    // MARK: - Chunk transfer

    private func putChunkWithBackoff(
        to sessionUri: String, data: Data, start: Int64, end: Int64, total: Int64
    ) async throws {
        guard let url = URL(string: sessionUri) else { throw UploadError.failed }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("bytes \(start)-\(end - 1)/\(total)", forHTTPHeaderField: "Content-Range")

        // Background upload tasks must be backed by a file, not an in-memory body.
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("amchunk_\(UUID().uuidString)")
        try data.write(to: tmp, options: .atomic)
        defer { try? FileManager.default.removeItem(at: tmp) }

        var attempt = 0
        while true {
            do {
                try await send(request, fromFile: tmp)
                return
            } catch {
                attempt += 1
                if attempt > Self.maxChunkRetries {
                    AppLog.error("bg_upload_chunk_give_up start=\(start) err=\(error.localizedDescription)")
                    throw error
                }
                let backoff = min(30.0, pow(2.0, Double(attempt)))
                try? await Task.sleep(for: .seconds(backoff))
            }
        }
    }

    private func send(_ request: URLRequest, fromFile file: URL) async throws {
        let task = session.uploadTask(with: request, fromFile: file)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            continuations[task.taskIdentifier] = cont
            lock.unlock()
            task.resume()
        }
    }

    private static func fileSize(_ url: URL) -> Int64 {
        (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
    }
}

// MARK: - URLSession delegate (background queue)

extension BackgroundUploadService: URLSessionDataDelegate {
    nonisolated func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        lock.lock()
        let cont = continuations.removeValue(forKey: task.taskIdentifier)
        lock.unlock()

        if let error {
            cont?.resume(throwing: error)
            return
        }
        // GCS resumable: 308 = chunk accepted, session still open; 2xx = finalised.
        let status = (task.response as? HTTPURLResponse)?.statusCode
        if let status, !(200...299).contains(status), status != 308 {
            cont?.resume(throwing: UploadError.failed)
            return
        }
        cont?.resume()
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        DispatchQueue.main.async { handler?() }
    }
}
