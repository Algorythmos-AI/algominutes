import Foundation

enum NoteStatus: String, Codable, CaseIterable, Sendable {
    case recording, processing, queued, chunking, transcribing, summarizing, ready, error

    var label: String {
        switch self {
        case .recording: return "Recording"
        case .processing: return "Processing"
        case .queued: return "Queued"
        case .chunking: return "Chunking audio"
        case .transcribing: return "Transcribing"
        case .summarizing: return "Summarizing"
        case .ready: return "Ready"
        case .error: return "Error"
        }
    }

    var isInProgress: Bool {
        self != .ready && self != .error
    }
}

enum NoteType: String, Codable, Sendable {
    case recording
    case importAudio = "import_audio"
    case importPdf = "import_pdf"
    case youtube
    case scanText = "scan_text"
    case onlineMeeting = "online_meeting"
}

struct Summary: Equatable, Sendable {
    var gist: String
    var actionItems: [String]
    var keyDecisions: [String]
    var keyPoints: [String]?
}

struct TranscriptLine: Equatable, Sendable, Identifiable {
    /// Position in the transcript, and the SwiftUI identity.
    ///
    /// Identity must never be derived from content. The previous
    /// `"\(speaker)|\(time)|\(text.prefix(48))"` collided on the utterances a
    /// conversation is full of — "Yes.", "Okay.", "Mm-hm." from the same
    /// speaker at the same displayed timestamp produced identical ids, and
    /// duplicate ids in a `ForEach` are undefined behaviour in SwiftUI:
    /// dropped rows, broken diffing, scroll-position jumps. That was survivable
    /// while the transcript was capped at the 200 lines Firestore mirrors; it
    /// becomes routine at the 3-6k lines a long meeting actually has.
    ///
    /// The ordinal also survives the swap from the mirrored preview to the
    /// full transcript: both are ordered by start_ms, so line n keeps id n and
    /// SwiftUI diffs an append rather than a wholesale replacement — which is
    /// what preserves scroll position when the full fetch lands.
    let index: Int
    var speaker: String
    var text: String
    var time: String
    /// Exact offset into the audio, when it is known.
    ///
    /// Firestore mirrors only the display string ("0:42"), so lines from the
    /// live listener have nil here and a tap can at best parse that back.
    /// `/api/note` returns the real `start_ms`, which is what makes
    /// tap-to-seek land on the word rather than near it.
    var startMs: Double?

    var id: Int { index }
}

struct NoteProgress: Equatable, Sendable {
    var done: Int
    var total: Int
}

/// Mirrors the Firestore note document (`src/types.ts` Note). Dates are kept
/// as ISO-8601 strings — that's what the backend writes.
struct Note: Identifiable, Equatable, Sendable {
    var id: String
    var title: String
    var workspaceId: String
    var authorId: String
    var status: NoteStatus
    var type: NoteType
    var sourceUrl: String?
    var duration: Double?
    var wordCount: Int?
    var createdAt: String
    var updatedAt: String
    var lastProgressAt: String?
    var summary: Summary?
    var transcript: [TranscriptLine]?
    var transcriptTruncated: Bool?
    var rawText: String?
    var errorMessage: String?
    var diagnosticCode: String?
    var storagePath: String?
    var mimeType: String?
    var jobId: String?
    var progress: NoteProgress?
    var retryAttempt: Int?

    var createdAtDate: Date? { Note.parseISO(createdAt) }
    var updatedAtDate: Date? { Note.parseISO(updatedAt) }
    var lastProgressAtDate: Date? { lastProgressAt.flatMap(Note.parseISO) }

    static func parseISO(_ s: String) -> Date? {
        // Backend writes `new Date().toISOString()` — fractional seconds.
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func isoNow(_ date: Date = Date()) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}

// MARK: - Firestore mapping (dictionary-based; resilient to partial docs)

extension Note {
    init?(id: String, data: [String: Any]) {
        guard let workspaceId = data["workspaceId"] as? String else { return nil }
        self.id = id
        self.workspaceId = workspaceId
        self.title = data["title"] as? String ?? "Untitled"
        self.authorId = data["authorId"] as? String ?? ""
        self.status = (data["status"] as? String).flatMap(NoteStatus.init(rawValue:)) ?? .processing
        self.type = (data["type"] as? String).flatMap(NoteType.init(rawValue:)) ?? .recording
        self.sourceUrl = data["sourceUrl"] as? String
        self.duration = (data["duration"] as? NSNumber)?.doubleValue
        self.wordCount = (data["wordCount"] as? NSNumber)?.intValue
        self.createdAt = data["createdAt"] as? String ?? ""
        self.updatedAt = data["updatedAt"] as? String ?? ""
        self.lastProgressAt = data["lastProgressAt"] as? String
        if let s = data["summary"] as? [String: Any] {
            self.summary = Summary(
                gist: s["gist"] as? String ?? "",
                actionItems: s["actionItems"] as? [String] ?? [],
                keyDecisions: s["keyDecisions"] as? [String] ?? [],
                keyPoints: s["keyPoints"] as? [String]
            )
        }
        if let lines = data["transcript"] as? [[String: Any]] {
            // Firestore mirrors the first 200 lines in start_ms order, so the
            // array position is the transcript position — see TranscriptLine.index.
            self.transcript = lines.enumerated().map { offset, line in
                // The fast path embeds the speaker in the text as
                // "Speaker 1: …"; reconcile before display or the row shows a
                // "Speaker" chip above text that repeats it. See SpeakerLabel.
                let split = SpeakerLabel.split(
                    speaker: line["speaker"] as? String,
                    text: line["text"] as? String ?? ""
                )
                return TranscriptLine(
                    index: offset,
                    speaker: split.label,
                    text: split.text,
                    time: line["time"] as? String ?? ""
                )
            }
        }
        self.transcriptTruncated = data["transcriptTruncated"] as? Bool
        self.rawText = data["rawText"] as? String
        self.errorMessage = data["errorMessage"] as? String
        self.diagnosticCode = data["diagnosticCode"] as? String
        self.storagePath = data["storagePath"] as? String
        self.mimeType = data["mimeType"] as? String
        self.jobId = data["jobId"] as? String
        if let p = data["progress"] as? [String: Any],
           let done = (p["done"] as? NSNumber)?.intValue,
           let total = (p["total"] as? NSNumber)?.intValue {
            self.progress = NoteProgress(done: done, total: total)
        }
        self.retryAttempt = (data["retryAttempt"] as? NSNumber)?.intValue
    }
}
