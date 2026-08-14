import FirebaseStorage
import Foundation
import UIKit

enum UploadError: LocalizedError {
    case timedOut
    case tooLarge(limitLabel: String, isRecording: Bool)
    case failed

    var errorDescription: String? {
        switch self {
        case .timedOut:
            // The condition is now "no bytes moved", not "N minutes passed", so
            // naming a duration would be wrong again — a slow upload that keeps
            // progressing is never cancelled, however long it takes. The
            // recording is kept and retried, and saying so is what stops this
            // reading as data loss.
            return "Upload stopped because the connection dropped. "
                 + "Your recording is saved and will upload when you're back online."
        case .tooLarge(let limit, let isRecording):
            return isRecording
                ? "That recording is too large. The current limit is \(limit)."
                : "That file is too large. The current limit is \(limit)."
        case .failed:
            return "Upload failed. Please check your connection and try again."
        }
    }
}

/// Direct-to-Firebase-Storage uploads — parity with `uploadAndProcess` /
/// `ImportPanel` in the web app (resumable upload, progress, 10-min timeout
/// for recordings, storage/unauthorized → size-limit copy).
@MainActor
final class UploadService {
    // The fixed deadline is gone; see UploadStallPolicy. A ~57 MB two-hour
    // recording on a slow uplink can legitimately exceed any duration worth
    // picking, and cancelling it produced a restart loop rather than an error.

    private var storage: Storage { Storage.storage() }

    /// Uploads a local file. `onProgress` receives 0-100.
    func upload(
        fileURL: URL,
        to storagePath: String,
        contentType: String,
        kind: StorageKind,
        applyTimeout: Bool,
        onProgress: @escaping @MainActor (Int) -> Void
    ) async throws {
        let ref = storage.reference(withPath: storagePath)
        let metadata = StorageMetadata()
        metadata.contentType = contentType

        // Keep the upload alive briefly if the user backgrounds the app. If the
        // OS reclaims the extra time before the upload finishes, end the task
        // cleanly — the recording is persisted on disk (PR-i1) and resumes from
        // disk on the next foreground/launch (AppEnvironment.resumePendingUploads).
        var bgTask = UIBackgroundTaskIdentifier.invalid
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "wassup-upload") {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }
        defer {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }

        let task = ref.putFile(from: fileURL, metadata: metadata)
        var timedOut = false

        // Stall-based, not wall-clock. A 57 MB two-hour recording on a slow
        // clinic uplink can legitimately exceed any fixed deadline, and because
        // the local file survives and resumePendingUploads restarts from byte
        // zero, a wall-clock cancel put the upload in a loop it never escaped.
        let startedAt = Date()
        // Written from Firebase's callback queue, read from the timer, so the
        // access is guarded. Same shape as `finished` below.
        let progressLock = NSLock()
        nonisolated(unsafe) var lastProgressAt = Date()

        let timeoutTimer: Timer? = applyTimeout
            ? Timer.scheduledTimer(
                withTimeInterval: UploadStallPolicy.checkIntervalSeconds, repeats: true
              ) { _ in
                progressLock.lock()
                let last = lastProgressAt
                progressLock.unlock()
                let verdict = UploadStallPolicy.evaluate(
                    startedAt: startedAt, lastProgressAt: last, now: Date()
                )
                guard verdict != .healthy else { return }
                timedOut = true
                task.cancel()
            }
            : nil
        defer { timeoutTimer?.invalidate() }

        do {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                nonisolated(unsafe) var finished = false
                task.observe(.progress) { snapshot in
                    guard let p = snapshot.progress, p.totalUnitCount > 0 else { return }
                    // Every byte that arrives resets the stall clock.
                    progressLock.lock()
                    lastProgressAt = Date()
                    progressLock.unlock()
                    let percent = Int((Double(p.completedUnitCount) / Double(p.totalUnitCount) * 100).rounded())
                    Task { @MainActor in onProgress(percent) }
                }
                task.observe(.success) { _ in
                    guard !finished else { return }
                    finished = true
                    cont.resume()
                }
                task.observe(.failure) { snapshot in
                    guard !finished else { return }
                    finished = true
                    cont.resume(throwing: snapshot.error ?? UploadError.failed)
                }
            }
        } catch {
            let ns = error as NSError
            let code = StorageErrorCode(rawValue: ns.code)
            if timedOut || code == .cancelled {
                throw UploadError.timedOut
            }
            if code == .unauthorized || code == .quotaExceeded {
                let limit = kind == .importFile ? "500 MB" : "120 MB"
                throw UploadError.tooLarge(limitLabel: limit, isRecording: kind == .recording)
            }
            throw UploadError.failed
        }
    }

    /// Best-effort upload of in-memory data (scan source blobs).
    func uploadData(_ data: Data, to storagePath: String, contentType: String) {
        let metadata = StorageMetadata()
        metadata.contentType = contentType
        storage.reference(withPath: storagePath).putData(data, metadata: metadata) { _, error in
            if let error {
                AppLog.error("scan_source_upload_failed: \(error.localizedDescription)")
            }
        }
    }
}
