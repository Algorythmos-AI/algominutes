import Foundation

/// Decoding for `/api/note`, the full-note read backed by Postgres.
///
/// Firestore mirrors only the first 200 transcript lines, so a long meeting
/// has never been readable in full on the client. This is the shape that
/// fixes that.
///
/// Only the transcript is modelled: the summary and metadata already arrive
/// through the Firestore listener, and decoding them again here would create
/// a second source of truth for fields the live listener keeps fresher.
struct TranscriptPageResponse: Decodable {
    struct Line: Decodable {
        let id: String
        let speaker: String?
        let speakerTag: Int?
        let startMs: Double?
        let endMs: Double?
        let text: String
    }

    struct Transcript: Decodable {
        let lines: [Line]
        let totalLines: Int?
        let nextCursor: String?
    }

    let transcript: Transcript
}

extension TranscriptPageResponse.Line {
    /// Convert to the app's line type, assigning the ordinal the caller has
    /// reached so identity stays positional and stable across pages.
    ///
    /// The speaker resolves from the server first, then degrades rather than
    /// pretending. With whole-file diarisation (ADR 0005) the long path now
    /// carries real speaker tags, and note-read resolves the display name:
    /// a note_speakers rename → "Speaker N" → the fast-path embedded name.
    func asTranscriptLine(index: Int) -> TranscriptLine {
        let split = SpeakerLabel.split(speaker: speaker, text: text)
        // Honour a server-resolved CUSTOM name (a note_speakers rename) — the
        // server already did the resolution, so a rename shows up on-device
        // without the client rebuilding "Speaker N" from the tag and dropping
        // it. When the server only sent the bare "Speaker N" it would synthesise
        // anyway, keep the existing contract: tag wins, then embedded label.
        let synthesized = speakerTag.map { "Speaker \($0)" }
        let label: String
        if let s = speaker, !s.isEmpty, s != "Speaker", s != synthesized {
            label = s
        } else {
            label = synthesized ?? split.label
        }
        return TranscriptLine(
            index: index,
            speaker: label,
            text: split.text,
            time: startMs.map { formatTimestamp(ms: $0) } ?? "",
            startMs: startMs,
            speakerTag: speakerTag
        )
    }
}
