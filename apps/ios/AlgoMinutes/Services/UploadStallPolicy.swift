import Foundation

/// Has this upload stopped moving, or is it just slow?
///
/// The upload timeout used to be wall-clock: ten minutes after the transfer
/// began, cancel. A two-hour recording is about 57 MB, and on a clinic uplink
/// that can legitimately take longer than ten minutes — so a perfectly healthy
/// upload was cancelled, and because the local file survives and
/// `resumePendingUploads` restarts it from byte zero on the next foreground, it
/// was cancelled again at ten minutes, forever. The recording never left the
/// device, and nothing about it looked like an error.
///
/// What matters is whether bytes are moving, not how long it has taken.
enum UploadStallPolicy {
    /// No progress at all for this long means the transfer is dead rather than
    /// slow. Generous, because a phone switching from wifi to cellular can go
    /// quiet for a while and still recover.
    static let stallSeconds: TimeInterval = 120

    /// A backstop for the case where progress keeps arriving but the upload
    /// never completes. An hour is far past any legitimate recording upload.
    static let hardCeilingSeconds: TimeInterval = 3600

    /// How often to check. Not the timeout itself.
    static let checkIntervalSeconds: TimeInterval = 15

    enum Verdict: Equatable {
        case healthy
        case stalled
        case exceededCeiling
    }

    static func evaluate(
        startedAt: Date,
        lastProgressAt: Date,
        now: Date
    ) -> Verdict {
        if now.timeIntervalSince(startedAt) >= hardCeilingSeconds { return .exceededCeiling }
        // Measured from the last byte, not from the start.
        if now.timeIntervalSince(lastProgressAt) >= stallSeconds { return .stalled }
        return .healthy
    }
}
