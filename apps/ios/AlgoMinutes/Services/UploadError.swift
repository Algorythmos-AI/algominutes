import Foundation

/// Upload failures the UI can explain (BackgroundUploadService, the only upload
/// path: POST /v1/uploads).
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
