import Foundation
import Network

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
/// The rest of a file goes as ONE background PUT (PR-24). Chunked PUTs only
/// moved while the app ran, so a suspended or killed app finished the chunk in
/// flight and nothing more until it was opened again; a 3-hour recording then
/// waited on the user. One task for the remainder runs to the end in the
/// system's upload daemon, app or no app. A failure asks the server how far it
/// got (`uploadSessionStatus`) and sends the rest again.
///
/// Cross-launch: the continuation bridge below only spans the current process.
/// When the system relaunches the app for a task that finished while it wasn't
/// running, `onOrphanUploadFinished` re-drives `AppEnvironment.resumePendingUploads`,
/// which finds the session complete and finishes the job (complete + kickoff).
/// A task still running from an earlier launch is joined, never duplicated.
@MainActor
final class BackgroundUploadService: NSObject {
    static let sessionIdentifier = "com.algorythmos.algominutes.upload"
    /// Set once so the AppDelegate can hand back the system's background-events
    /// completion handler after a background wake.
    static weak var shared: BackgroundUploadService?

    private static let maxAttempts = 4

    /// Handed over by the AppDelegate's
    /// `handleEventsForBackgroundURLSession`; called once the session has
    /// flushed its queued delegate events.
    nonisolated(unsafe) var backgroundCompletionHandler: (() -> Void)?

    /// Called on the main actor when a transfer finishes that no caller in this
    /// process is waiting for (it was started before the app was killed).
    var onOrphanUploadFinished: (() -> Void)?

    private let store: RecordingStore
    private let api: APIClient

    // Bridges each delegate-driven task back to its awaiting callers. Keyed by
    // task identifier and guarded by `lock` because the delegate fires on the
    // session's private queue, not the main actor. A list per task: a second
    // caller that joins a running task (send) waits alongside the first, where
    // it used to replace the first one's continuation and leave it hanging.
    private let lock = NSLock()
    nonisolated(unsafe) private var continuations: [Int: [CheckedContinuation<Void, Error>]] = [:]
    nonisolated(unsafe) private var progressHandlers: [Int: @Sendable (Int64) -> Void] = [:]

    // Whether the network can carry an upload now, for the stall watch: a
    // background session waits for connectivity without telling its delegate.
    private let pathMonitor = NWPathMonitor()
    nonisolated(unsafe) private var networkUsable = true
    // Tasks the stall watch cancelled: their cancellation reads as timedOut.
    nonisolated(unsafe) private var stalledTasks = Set<Int>()

    init(store: RecordingStore, api: APIClient) {
        self.store = store
        self.api = api
        super.init()
        Self.shared = self
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.networkChanged(
                connected: path.status == .satisfied,
                onWifi: path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            )
        }
        pathMonitor.start(queue: DispatchQueue(label: "algominutes.upload-network"))
    }

    /// The path monitor's queue: whether the network can carry an upload now.
    nonisolated private func networkChanged(connected: Bool, onWifi: Bool) {
        let usable = UploadStallPolicy.networkAllowsUpload(connected: connected, onWifi: onWifi, wifiOnly: UploadPreferences.wifiOnly)
        lock.lock()
        networkUsable = usable
        lock.unlock()
    }

    /// How a failed POST /v1/uploads reaches the caller. Its only 404 is a deleted
    /// note (services/api uploads.js), typed so the caller doesn't retry into it.
    nonisolated static func sessionError(_ error: Error) -> Error {
        if case APIError.http(let status, _) = error, status == 404 { return UploadError.noteGone }
        return error
    }

    /// Recreate the background session after a wake, so the system can deliver
    /// the events it queued for it (the AppDelegate calls this). Without it the
    /// lazy session was never touched on a background launch, no event arrived,
    /// and the system's completion handler was never called.
    func reconnect() {
        _ = session
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
        if let id = uploadId, sessionUri != nil,
           let status = try? await api.uploadSessionStatus(uploadId: id) {
            offset = status.complete ? total : min(status.receivedBytes, total)
        } else {
            let created: APIClient.CreateUploadSessionResponse
            do {
                created = try await api.createUploadSession(
                    noteId: noteId,
                    workspaceId: workspaceId,
                    fileName: fileName,
                    contentType: contentType,
                    totalBytes: total
                )
            } catch {
                throw Self.sessionError(error)
            }
            uploadId = created.uploadId
            sessionUri = created.sessionUri
            if let pending {
                store.setUploadSession(fileName: pending.fileName, uploadId: created.uploadId, sessionUri: created.sessionUri)
            }
        }
        guard let uploadId, let sessionUri else { throw UploadError.failed }
        if let pending {
            store.setUploadState(fileName: pending.fileName, state: .uploading, uploadedBytes: offset)
        }

        var attempt = 0
        while offset < total {
            do {
                try await putRemainder(
                    of: fileURL, from: offset, total: total, to: sessionUri, uploadId: uploadId, onProgress: onProgress
                )
                offset = total
            } catch {
                attempt += 1
                if attempt >= Self.maxAttempts {
                    AppLog.error("bg_upload_give_up offset=\(offset) err=\(error.localizedDescription)")
                    throw error
                }
                // The PUT may have landed part of the file: continue from where
                // the server is, not from where this attempt started.
                if let status = try? await api.uploadSessionStatus(uploadId: uploadId) {
                    offset = status.complete ? total : min(status.receivedBytes, total)
                }
                let backoff = min(30.0, pow(2.0, Double(attempt)))
                try? await Task.sleep(for: .seconds(backoff))
            }
            if let pending {
                store.setUploadState(fileName: pending.fileName, state: .uploading, uploadedBytes: offset)
            }
        }
        onProgress(100)

        let done = try await api.completeUpload(uploadId: uploadId)
        if let pending {
            store.setUploadState(fileName: pending.fileName, state: .processing, uploadedBytes: offset)
            store.setUploadSession(fileName: pending.fileName, uploadId: nil, sessionUri: nil)
        }
        return done.storagePath
    }

    // MARK: - Transfer

    /// `Content-Range` for the rest of a file from `offset`: the final (and only)
    /// PUT of a GCS resumable session, which may be any size.
    nonisolated static func contentRange(from offset: Int64, total: Int64) -> String {
        "bytes \(offset)-\(total - 1)/\(total)"
    }

    /// Where a resume's tail copy lives until its transfer ends: Caches, not tmp,
    /// because the system's upload daemon reads it after the app may be gone.
    nonisolated static func tailDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("upload-tails", isDirectory: true)
    }

    /// Copy the bytes of `fileURL` from `offset` to the end into a file of their
    /// own: a background upload task reads its whole body from a file.
    nonisolated static func writeTail(of fileURL: URL, from offset: Int64, uploadId: String) throws -> URL {
        let dir = tailDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tail = dir.appendingPathComponent("\(uploadId)-\(offset)")
        try? FileManager.default.removeItem(at: tail)
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        FileManager.default.createFile(atPath: tail.path, contents: nil)
        let out = try FileHandle(forWritingTo: tail)
        defer { try? out.close() }
        // Copy in slices so a 3-hour recording's tail never sits in memory whole.
        while true {
            let slice = handle.readData(ofLength: 4 * 1024 * 1024)
            if slice.isEmpty { break }
            out.write(slice)
        }
        return tail
    }

    private func putRemainder(
        of fileURL: URL, from offset: Int64, total: Int64, to sessionUri: String, uploadId: String,
        onProgress: @escaping @MainActor (Int) -> Void
    ) async throws {
        guard let url = URL(string: sessionUri) else { throw UploadError.failed }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(Self.contentRange(from: offset, total: total), forHTTPHeaderField: "Content-Range")

        // From byte 0 the body is the file itself; a resume sends a copy of the tail.
        let tail = offset == 0 ? nil : try Self.writeTail(of: fileURL, from: offset, uploadId: uploadId)
        defer { if let tail { try? FileManager.default.removeItem(at: tail) } }

        let report: @Sendable (Int64) -> Void = { sent in
            let percent = Int((Double(offset + sent) / Double(total) * 100).rounded())
            Task { @MainActor in onProgress(min(99, percent)) }
        }
        try await send(request, fromFile: tail ?? fileURL, uploadId: uploadId, onSent: report)
    }

    private func send(
        _ request: URLRequest, fromFile file: URL, uploadId: String, onSent: @escaping @Sendable (Int64) -> Void
    ) async throws {
        // A transfer for this session already running (started before the app
        // was killed) is joined: a second PUT to the same session would race it.
        let running = await session.allTasks.first { $0.taskDescription == uploadId && $0.state == .running }
        let task: URLSessionTask
        if let running {
            AppLog.info("bg_upload_joined_running_task uploadId=\(uploadId)")
            task = running
        } else {
            task = session.uploadTask(with: request, fromFile: file)
            task.taskDescription = uploadId
        }
        // The transfer is watched while this caller waits: one that stops moving
        // is cancelled, so the wait always ends and the caller's retry continues
        // from the server's byte count. It used to wait out URLSession's 7-day
        // resource timeout, with the note's upload progress stuck on screen.
        let watcher = Task { [weak self] in await self?.watch(task, uploadId: uploadId) }
        defer { watcher.cancel() }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            continuations[task.taskIdentifier, default: []].append(cont)
            progressHandlers[task.taskIdentifier] = onSent
            lock.unlock()
            task.resume()
        }
    }

    /// Cancels `task` once UploadStallPolicy says it has stopped: no bytes for
    /// `stallSeconds` while the network could carry them, or past the ceiling.
    /// Reads the system's own byte count, not delegate events, which arrive late
    /// after a suspension.
    private func watch(_ task: URLSessionTask, uploadId: String) async {
        var w = UploadStallPolicy.Watch(bytes: task.countOfBytesSent, now: Date())
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(UploadStallPolicy.checkIntervalSeconds))
            if Task.isCancelled || task.state != .running { return }
            let usable = lock.withLock { networkUsable }
            let verdict = UploadStallPolicy.step(&w, bytesSent: task.countOfBytesSent, networkUsable: usable, now: Date())
            guard verdict != .healthy else { continue }
            AppLog.error("bg_upload_\(verdict == .stalled ? "stalled" : "past_ceiling") uploadId=\(uploadId) sent=\(task.countOfBytesSent)")
            _ = lock.withLock { stalledTasks.insert(task.taskIdentifier) }
            task.cancel()
            return
        }
    }

    private static func fileSize(_ url: URL) -> Int64 {
        (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
    }
}

// MARK: - URLSession delegate (background queue)

extension BackgroundUploadService: URLSessionDataDelegate {
    nonisolated func urlSession(
        _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64, totalBytesExpectedToSend: Int64
    ) {
        lock.lock()
        let report = progressHandlers[task.taskIdentifier]
        lock.unlock()
        report?(totalBytesSent)
    }

    nonisolated func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        lock.lock()
        let waiting = continuations.removeValue(forKey: task.taskIdentifier) ?? []
        progressHandlers.removeValue(forKey: task.taskIdentifier)
        let stalled = stalledTasks.remove(task.taskIdentifier) != nil
        lock.unlock()

        // Nobody in this process is waiting: it was started before the app was
        // killed, and the system relaunched the app to deliver it. Hand it to the
        // resume path, which reads the session's state from the server and
        // finishes (or retries) the upload.
        if waiting.isEmpty {
            Task { @MainActor [weak self] in self?.onOrphanUploadFinished?() }
            return
        }

        let status = (task.response as? HTTPURLResponse)?.statusCode
        let outcome: Error? = stalled ? UploadError.timedOut : Self.outcome(error: error, status: status)
        for cont in waiting {
            if let failure = outcome { cont.resume(throwing: failure) } else { cont.resume() }
        }
    }

    /// What a finished PUT means: nil when GCS finalised the object (2xx), else
    /// the error the caller's retry works from. Each PUT sends the rest of the
    /// file, so a 308 (the session still open) means GCS didn't take it all: the
    /// caller asks the server how far it got and sends the rest. It used to count
    /// as done, and `complete` then failed on an unfinished object.
    nonisolated static func outcome(error: Error?, status: Int?) -> Error? {
        if let error { return error }
        guard let status else { return UploadError.failed }
        if (200...299).contains(status) { return nil }
        if status == 308 { return UploadError.incomplete }
        return UploadError.failed
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        DispatchQueue.main.async { handler?() }
    }
}
