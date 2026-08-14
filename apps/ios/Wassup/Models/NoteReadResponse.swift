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
    /// The speaker degrades rather than pretending: diarization is disabled in
    /// production, so most rows carry no label at all and rendering "Speaker"
    /// everywhere would imply an attribution the data does not support.
    func asTranscriptLine(index: Int) -> TranscriptLine {
        // One rule for both pipelines — see SpeakerLabel. speaker_tag wins
        // when STT actually diarized; otherwise fall back to whatever the
        // fast path embedded in the text.
        let split = SpeakerLabel.split(speaker: speaker, text: text)
        let label = speakerTag.map { "Speaker \($0)" } ?? split.label
        return TranscriptLine(
            index: index,
            speaker: label,
            text: split.text,
            time: startMs.map { formatTimestamp(ms: $0) } ?? "",
            startMs: startMs
        )
    }
}
