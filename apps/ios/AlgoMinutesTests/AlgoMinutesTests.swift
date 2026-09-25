import XCTest
import UIKit
import AVFoundation
import AuthenticationServices
@testable import AlgoMinutes

// MARK: - TitleDeriver (parity with deriveTitleFromSummary)

final class TitleDeriverTests: XCTestCase {
    func testDerivesFirstSentence() {
        XCTAssertEqual(
            TitleDeriver.derive(fromGist: "We agreed on the Q3 roadmap. Also discussed hiring."),
            "We agreed on the Q3 roadmap"
        )
    }

    func testStripsTrailingPunctuation() {
        XCTAssertEqual(TitleDeriver.derive(fromGist: "Kickoff call!!"), "Kickoff call")
    }

    func testNilForEmptyGist() {
        XCTAssertNil(TitleDeriver.derive(fromGist: ""))
        XCTAssertNil(TitleDeriver.derive(fromGist: "   "))
        XCTAssertNil(TitleDeriver.derive(fromGist: nil))
    }

    func testCapsAt80CharsCuttingAtSpace() {
        let long = String(repeating: "word ", count: 30) // 150 chars, no sentence break
        let title = TitleDeriver.derive(fromGist: long)!
        XCTAssertTrue(title.hasSuffix("…"))
        XCTAssertLessThanOrEqual(title.count, 81)
        XCTAssertFalse(title.dropLast().hasSuffix(" "))
    }

    func testHardCutWhenNoLateSpace() {
        let long = String(repeating: "a", count: 120)
        let title = TitleDeriver.derive(fromGist: long)!
        XCTAssertEqual(title.count, 81) // 80 + ellipsis
    }

    func testPlaceholderDetection() {
        XCTAssertTrue(TitleDeriver.isPlaceholder("Session_2026-07-15"))
        XCTAssertTrue(TitleDeriver.isPlaceholder("Import_2025-01-02"))
        XCTAssertFalse(TitleDeriver.isPlaceholder("Team standup"))
        XCTAssertFalse(TitleDeriver.isPlaceholder("Session_26-07-15"))
    }
}

// MARK: - StuckBudgets (parity with the App.tsx watchdog)

final class StuckBudgetsTests: XCTestCase {
    private func note(id: String = "n1", status: NoteStatus, ageSeconds: Double, duration: Double? = nil) -> Note {
        let reference = Date().addingTimeInterval(-ageSeconds)
        var note = Note(
            id: id, title: "t", workspaceId: "ws", authorId: "u",
            status: status, type: .recording, sourceUrl: nil, duration: duration,
            wordCount: nil, createdAt: Note.isoNow(), updatedAt: Note.isoNow(reference),
            lastProgressAt: nil, summary: nil, transcript: nil, transcriptTruncated: nil,
            rawText: nil, errorMessage: nil, diagnosticCode: nil, storagePath: nil,
            mimeType: nil, jobId: nil, progress: nil, retryAttempt: nil
        )
        note.lastProgressAt = nil
        return note
    }

    func testBudgets() {
        XCTAssertEqual(StuckBudgets.effectiveBudgetMs(status: .processing, durationSeconds: nil), 90_000)
        XCTAssertEqual(StuckBudgets.effectiveBudgetMs(status: .queued, durationSeconds: nil), 90_000)
        XCTAssertEqual(StuckBudgets.effectiveBudgetMs(status: .chunking, durationSeconds: nil), 300_000)
        XCTAssertEqual(StuckBudgets.effectiveBudgetMs(status: .transcribing, durationSeconds: nil), 480_000)
        XCTAssertEqual(StuckBudgets.effectiveBudgetMs(status: .summarizing, durationSeconds: nil), 240_000)
        XCTAssertNil(StuckBudgets.effectiveBudgetMs(status: .ready, durationSeconds: nil))
        XCTAssertNil(StuckBudgets.effectiveBudgetMs(status: .error, durationSeconds: nil))
        XCTAssertNil(StuckBudgets.effectiveBudgetMs(status: .recording, durationSeconds: nil))
    }

    func testTranscribingScalesWithDuration() {
        // 60-minute recording → 3x realtime = 180 min > 8-min floor
        XCTAssertEqual(
            StuckBudgets.effectiveBudgetMs(status: .transcribing, durationSeconds: 3600),
            3600 * 1000 * 3
        )
        // Short clip keeps the 8-minute floor
        XCTAssertEqual(
            StuckBudgets.effectiveBudgetMs(status: .transcribing, durationSeconds: 30),
            480_000
        )
    }

    func testStuckDetection() {
        XCTAssertTrue(StuckBudgets.isStuck(note: note(status: .queued, ageSeconds: 120)))
        XCTAssertFalse(StuckBudgets.isStuck(note: note(status: .queued, ageSeconds: 30)))
        XCTAssertFalse(StuckBudgets.isStuck(note: note(status: .ready, ageSeconds: 10_000)))
        XCTAssertFalse(StuckBudgets.isStuck(note: note(status: .transcribing, ageSeconds: 600, duration: 3600)))
        XCTAssertTrue(StuckBudgets.isStuck(note: note(status: .transcribing, ageSeconds: 600, duration: 60)))
    }

    /// The watchdog only reports slow notes; a note that moves on drops out.
    func testSlowNotesAreReportedNotFailed() {
        let slow = note(id: "slow", status: .queued, ageSeconds: 120)
        let fresh = note(id: "fresh", status: .queued, ageSeconds: 30)
        let done = note(id: "done", status: .ready, ageSeconds: 10_000)
        XCTAssertEqual(NotesRepository.slowNoteIds(in: [slow, fresh, done], now: Date()), ["slow"])
        XCTAssertEqual(NotesRepository.slowNoteIds(in: [], now: Date()), [])
    }
}

// MARK: - SSEParser (parity with the ChatTab stream reader)

final class SSEParserTests: XCTestCase {
    func testCitationsFrame() {
        var parser = SSEParser()
        let frame = "event: citations\ndata: {\"hits\":[{\"noteId\":\"n1\",\"noteTitle\":\"T\",\"chunkText\":\"c\",\"startMs\":1000,\"endMs\":2000,\"score\":0.5,\"source\":\"vector\"}]}\n\n"
        let events = parser.feed(frame)
        guard case .citations(let hits)? = events.first else {
            return XCTFail("expected citations, got \(events)")
        }
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits[0].noteId, "n1")
        XCTAssertEqual(hits[0].startMs, 1000)
    }

    func testTextDeltas() {
        var parser = SSEParser()
        let events = parser.feed("data: {\"text\":\"Hello \"}\n\ndata: {\"text\":\"world\"}\n\n")
        XCTAssertEqual(events, [.textDelta("Hello "), .textDelta("world")])
    }

    func testSplitAcrossChunks() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed("data: {\"te"), [])
        XCTAssertEqual(parser.feed("xt\":\"hi\"}\n"), [])
        XCTAssertEqual(parser.feed("\n"), [.textDelta("hi")])
    }

    func testDoneAndError() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed("event: done\ndata: {}\n\n"), [.done])
        XCTAssertEqual(
            parser.feed("event: error\ndata: {\"error\":\"stream_failed\"}\n\n"),
            [.serverError("stream_failed")]
        )
    }

    func testIgnoresNonTextFrames() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed("data: {\"other\":1}\n\n"), [])
    }
}

// MARK: - TextNoteBuilder (parity with finalizeExtractedTextNote)

final class TextNoteBuilderTests: XCTestCase {
    func testBasicBuild() {
        let result = TextNoteBuilder.build(text: "First paragraph line.\n\nSecond paragraph.", source: .scannedImage)
        XCTAssertEqual(result.transcript.count, 2)
        XCTAssertEqual(result.transcript[0].speaker, "Scanned image")
        XCTAssertEqual(result.wordCount, 5)
        XCTAssertTrue(result.gist.hasPrefix("Scanned image - 5 words extracted."))
        XCTAssertEqual(result.title, "First paragraph line.")
        XCTAssertFalse(result.transcriptTruncated)
    }

    func testEmptyText() {
        let result = TextNoteBuilder.build(text: "", source: .pdf)
        XCTAssertEqual(result.transcript.count, 1)
        XCTAssertTrue(result.transcript[0].text.contains("No text detected"))
        XCTAssertNil(result.title)
    }

    func testTruncation() {
        let long = String(repeating: "a", count: 200_000)
        let result = TextNoteBuilder.build(text: long, source: .imported)
        XCTAssertTrue(result.transcriptTruncated)
        XCTAssertTrue(result.rawText.hasSuffix("[Text truncated for mobile display.]"))
        XCTAssertTrue(result.gist.contains("(truncated)"))
    }

    func testTitleCapsAt60() {
        let line = String(repeating: "t", count: 90)
        let result = TextNoteBuilder.build(text: line, source: .imported)
        XCTAssertEqual(result.title, String(repeating: "t", count: 60) + "...")
    }

    func testStripsNulCharacters() {
        let result = TextNoteBuilder.build(text: "a\0b", source: .imported)
        XCTAssertEqual(result.rawText, "ab")
    }

    func testRepeatedParagraphsGetDistinctIdentities() {
        // Same speaker, same (empty) time, identical text — the exact shape
        // that collided under the old content-derived id.
        let result = TextNoteBuilder.build(text: "Yes.\n\nYes.\n\nYes.", source: .imported)
        XCTAssertEqual(result.transcript.count, 3)
        XCTAssertEqual(Set(result.transcript.map(\.id)).count, 3)
        XCTAssertEqual(result.transcript.map(\.index), [0, 1, 2])
    }
}

// MARK: - Export scope and plain text

final class ExportScopeTests: XCTestCase {
    private func note(summary: Summary?) -> Note {
        Note(
            id: "n1", title: "CH Robinson", workspaceId: "ws", authorId: "u",
            status: .ready, type: .recording, sourceUrl: nil, duration: 3,
            wordCount: nil, createdAt: Note.isoNow(), updatedAt: Note.isoNow(),
            lastProgressAt: nil, summary: summary, transcript: nil,
            transcriptTruncated: nil, rawText: nil, errorMessage: nil,
            diagnosticCode: nil, storagePath: nil, mimeType: nil, jobId: nil,
            progress: nil, retryAttempt: nil
        )
    }
    private let summary = Summary(gist: "g", actionItems: ["a"], keyDecisions: ["d"], keyPoints: nil)
    private let lines = [TranscriptLine(index: 0, speaker: "A", text: "hello", time: "0:01", startMs: 1000)]

    func testOnlyOffersScopesTheNoteCanActuallyFill() {
        // Offering "Transcription" for a note with none produces an empty file.
        XCTAssertEqual(ExportScope.available(for: note(summary: summary), hasTranscript: false), [.summary])
        XCTAssertEqual(ExportScope.available(for: note(summary: nil), hasTranscript: true), [.transcript])
        XCTAssertEqual(ExportScope.available(for: note(summary: summary), hasTranscript: true), [.both, .summary, .transcript])
    }

    func testNothingToExportIsEmptyNotACrash() {
        XCTAssertTrue(ExportScope.available(for: note(summary: nil), hasTranscript: false).isEmpty)
    }

    func testSummaryScopeExcludesTheTranscript() {
        let text = NoteExport.plainText(note: note(summary: summary), scope: .summary, lines: lines)
        XCTAssertTrue(text.contains("EXECUTIVE SUMMARY"))
        XCTAssertFalse(text.contains("TRANSCRIPT"))
        XCTAssertFalse(text.contains("hello"))
    }

    func testTranscriptScopeExcludesTheSummary() {
        let text = NoteExport.plainText(note: note(summary: summary), scope: .transcript, lines: lines)
        XCTAssertTrue(text.contains("hello"))
        XCTAssertFalse(text.contains("EXECUTIVE SUMMARY"))
        XCTAssertFalse(text.contains("ACTION ITEMS"))
    }

    func testBothCarriesEverything() {
        let text = NoteExport.plainText(note: note(summary: summary), scope: .both, lines: lines)
        for expected in ["EXECUTIVE SUMMARY", "ACTION ITEMS", "KEY DECISIONS", "TRANSCRIPT", "hello"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected)")
        }
    }

    func testEveryExportCarriesTheRedactionNotice() {
        // Transcripts are redacted before storage and there is no clean copy,
        // so the user must learn that from the export itself.
        for scope in ExportScope.allCases {
            let text = NoteExport.plainText(note: note(summary: summary), scope: scope, lines: lines)
            XCTAssertTrue(text.contains(NoteExport.redactionNotice), "\(scope) dropped the notice")
        }
    }

    func testLinesWithoutSpeakerOrTimeStillExport() {
        let bare = [TranscriptLine(index: 0, speaker: "", text: "just words", time: "", startMs: nil)]
        let text = NoteExport.plainText(note: note(summary: nil), scope: .transcript, lines: bare)
        XCTAssertTrue(text.contains("just words"))
        XCTAssertFalse(text.contains("[]"), "rendered an empty prefix bracket")
    }

    func testFileNamesAreScopedAndFilesystemSafe() {
        let n = Note(
            id: "n1", title: "Q3/Q4: review", workspaceId: "ws", authorId: "u",
            status: .ready, type: .recording, sourceUrl: nil, duration: nil,
            wordCount: nil, createdAt: Note.isoNow(), updatedAt: Note.isoNow(),
            lastProgressAt: nil, summary: summary, transcript: nil, transcriptTruncated: nil,
            rawText: nil, errorMessage: nil, diagnosticCode: nil, storagePath: nil,
            mimeType: nil, jobId: nil, progress: nil, retryAttempt: nil
        )
        XCTAssertEqual(NoteExport.fileName(for: n, scope: .summary, ext: "pdf"), "Q3_Q4__review_Summary.pdf")
        XCTAssertEqual(NoteExport.fileName(for: n, scope: .transcript, ext: "txt"), "Q3_Q4__review_Transcript.txt")
        XCTAssertEqual(NoteExport.fileName(for: n, scope: .both, ext: "txt"), "Q3_Q4__review_Note.txt")
    }

    func testPunctuationOnlyTitleFallsBackInsteadOfProducingUnderscores() {
        // "///" maps to "___", which is not empty — an isEmpty check alone
        // would ship "____.pdf". Mirrors functions/export-note.cjs so the same
        // note exported from either path gets the same name.
        let n = Note(
            id: "n1", title: "///", workspaceId: "ws", authorId: "u",
            status: .ready, type: .recording, sourceUrl: nil, duration: nil,
            wordCount: nil, createdAt: Note.isoNow(), updatedAt: Note.isoNow(),
            lastProgressAt: nil, summary: summary, transcript: nil, transcriptTruncated: nil,
            rawText: nil, errorMessage: nil, diagnosticCode: nil, storagePath: nil,
            mimeType: nil, jobId: nil, progress: nil, retryAttempt: nil
        )
        XCTAssertEqual(NoteExport.fileName(for: n, scope: .both, ext: "pdf"), "Note_Note.pdf")
    }
}

// MARK: - Note title input
//
// Titles reach a filesystem: PDFExporter derives an export filename from the
// title, so a path separator there would write somewhere unintended.

final class NoteTitleInputTests: XCTestCase {
    func testStripsCharactersThatCannotSurviveAFilename() {
        XCTAssertEqual(NoteTitleInput.sanitize("Q3/Q4 review"), "Q3Q4 review")
        XCTAssertEqual(NoteTitleInput.sanitize("a\\b:c"), "abc")
        XCTAssertEqual(NoteTitleInput.sanitize("with\0nul"), "withnul")
    }

    func testKeepsSingleSpacesWhileTyping() {
        // Trimming trailing whitespace during input eats the space between
        // words, so sanitize must not do it — validated() trims at save time.
        XCTAssertEqual(NoteTitleInput.sanitize("Board meeting "), "Board meeting ")
        XCTAssertEqual(NoteTitleInput.sanitize("Board  meeting"), "Board meeting")
    }

    func testCapsAtTheServerLimit() {
        // shared/note-edit.cjs rejects anything longer, so stop accepting it
        // here rather than failing the save.
        let long = String(repeating: "t", count: 400)
        XCTAssertEqual(NoteTitleInput.sanitize(long).count, NoteTitleInput.maxLength)
    }

    func testNothingToSaveForEmptyOrWhitespace() {
        XCTAssertNil(NoteTitleInput.validated(""))
        XCTAssertNil(NoteTitleInput.validated("   "))
        XCTAssertNil(NoteTitleInput.validated("///"))
    }

    func testUnchangedTitleIsNotASave() {
        // A rename that is not a change should not cost a round trip or bump
        // updatedAt.
        XCTAssertNil(NoteTitleInput.validated("Board meeting", current: "Board meeting"))
        XCTAssertNil(NoteTitleInput.validated("  Board meeting  ", current: "Board meeting"))
        XCTAssertEqual(NoteTitleInput.validated("Board sync", current: "Board meeting"), "Board sync")
    }

    func testTrimsAtSaveTime() {
        XCTAssertEqual(NoteTitleInput.validated("  Kickoff  "), "Kickoff")
    }

    func testDefaultRecordingNameMatchesThePlaceholderPattern() {
        // TitleDeriver.isPlaceholder decides whether an auto-generated title
        // may be replaced by one derived from the gist. If the save sheet's
        // prefilled default stopped matching, every unnamed recording would
        // keep its Session_ name forever.
        let name = AppEnvironment.defaultRecordingName()
        XCTAssertTrue(TitleDeriver.isPlaceholder(name), "\(name) no longer matches the placeholder pattern")
    }
}

// MARK: - Transcript seeking
//
// The rule under test: a line that cannot be located in the audio must not be
// tappable. Returning 0 instead of nil would make a tap on an unparseable
// line silently jump to the start of a two-hour recording.

final class TranscriptTimeTests: XCTestCase {
    func testParsesTheFormatsTheBackendEmits() {
        XCTAssertEqual(TranscriptTime.seconds(from: "0:42"), 42)
        XCTAssertEqual(TranscriptTime.seconds(from: "12:30"), 750)
        XCTAssertEqual(TranscriptTime.seconds(from: "1:02:03"), 3723)
        XCTAssertEqual(TranscriptTime.seconds(from: " 9:05 "), 545)
    }

    func testReturnsNilRatherThanZeroOnAnythingUnrecognised() {
        for bad in ["", "  ", "abc", "42", "1:2:3:4", "1:xx", "-1:00", "1.5", "::", "1:", ":30"] {
            XCTAssertNil(TranscriptTime.seconds(from: bad), "\(bad) should not parse")
        }
    }

    func testRejectsImpossibleClockComponents() {
        // Corrupt data, not 99 seconds.
        XCTAssertNil(TranscriptTime.seconds(from: "0:99"))
        XCTAssertNil(TranscriptTime.seconds(from: "1:99:00"))
    }

    func testExactTimestampBeatsTheParsedString() {
        // The API value is authoritative; the display string is a fallback
        // for mirrored lines and can disagree after rounding.
        let line = TranscriptLine(index: 0, speaker: "", text: "t", time: "0:42", startMs: 41_500)
        XCTAssertEqual(TranscriptTime.seekTarget(for: line), 41.5)
    }

    func testFallsBackToTheDisplayStringWhenThereIsNoExactValue() {
        let line = TranscriptLine(index: 0, speaker: "", text: "t", time: "0:42", startMs: nil)
        XCTAssertEqual(TranscriptTime.seekTarget(for: line), 42)
    }

    func testUnlocatableLineHasNoSeekTarget() {
        let line = TranscriptLine(index: 0, speaker: "", text: "t", time: "", startMs: nil)
        XCTAssertNil(TranscriptTime.seekTarget(for: line))
    }
}

final class TranscriptActiveLineTests: XCTestCase {
    private func timed(_ starts: [Double?]) -> [TranscriptLine] {
        starts.enumerated().map { i, ms in
            TranscriptLine(index: i, speaker: "", text: "l\(i)", time: "", startMs: ms)
        }
    }

    func testFindsTheLastLineThatHasStarted() {
        let lines = timed([0, 5_000, 10_000, 15_000])
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 0), 0)
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 4.9), 0)
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 5), 1)
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 12), 2)
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 9_999), 3)
    }

    func testNothingIsHighlightedBeforeTheFirstLineStarts() {
        let lines = timed([5_000, 10_000])
        XCTAssertNil(TranscriptTime.activeIndex(in: lines, at: 1))
    }

    func testEmptyTranscriptHasNoActiveLine() {
        XCTAssertNil(TranscriptTime.activeIndex(in: [], at: 10))
    }

    func testUntimedLinesAreSkippedRatherThanStoppingTheFollow() {
        // A mixed transcript is real — the fast path can leave a line without
        // a usable timestamp, and that must not disable following for the
        // rest of the note.
        let lines = timed([0, nil, 10_000, nil, 20_000])
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 12), 2)
        XCTAssertEqual(TranscriptTime.activeIndex(in: lines, at: 25), 4)
    }

    func testAllUntimedMeansNoHighlight() {
        XCTAssertNil(TranscriptTime.activeIndex(in: timed([nil, nil, nil]), at: 30))
    }
}

// MARK: - Full transcript fetch
//
// Firestore mirrors only the first 200 lines, so anything longer has always
// been silently clipped. These cover the two places that quietly go wrong:
// choosing between the mirrored preview and the fetched transcript, and
// turning API rows into lines without inventing a speaker.

final class TranscriptMergeTests: XCTestCase {
    private func lines(_ n: Int, prefix: String = "l") -> [TranscriptLine] {
        (0..<n).map { TranscriptLine(index: $0, speaker: "", text: "\(prefix)\($0)", time: "") }
    }

    func testFullTranscriptWinsOnceItIsLonger() {
        let result = TranscriptRepository.preferred(
            full: lines(600), fullNoteId: "n1", mirrored: lines(200), noteId: "n1"
        )
        XCTAssertEqual(result.count, 600)
    }

    func testMirroredIsKeptWhenTheFetchIsNotLonger() {
        // A short note's mirror already is the whole transcript. Swapping it
        // for an identical fetch rebuilds the list and loses scroll position.
        let result = TranscriptRepository.preferred(
            full: lines(12), fullNoteId: "n1", mirrored: lines(12), noteId: "n1"
        )
        XCTAssertEqual(result.count, 12)
        XCTAssertEqual(result.first?.text, "l0")
    }

    func testAStaleResponseForAnotherNoteIsIgnored() {
        // A fetch still in flight for the previous note must never render
        // against the note now on screen.
        let result = TranscriptRepository.preferred(
            full: lines(900, prefix: "other"), fullNoteId: "n0", mirrored: lines(3), noteId: "n1"
        )
        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result.first?.text, "l0")
    }

    func testNoMirrorAndNoFetchIsEmptyNotACrash() {
        let result = TranscriptRepository.preferred(
            full: [], fullNoteId: nil, mirrored: nil, noteId: "n1"
        )
        XCTAssertTrue(result.isEmpty)
    }

    func testFetchRendersWhenThereWasNoMirrorAtAll() {
        let result = TranscriptRepository.preferred(
            full: lines(5), fullNoteId: "n1", mirrored: nil, noteId: "n1"
        )
        XCTAssertEqual(result.count, 5)
    }
}

final class TranscriptPageDecodingTests: XCTestCase {
    private func line(speaker: String?, tag: Int?, startMs: Double?) -> TranscriptPageResponse.Line {
        let json: [String: Any?] = [
            "id": "1", "speaker": speaker, "speakerTag": tag,
            "startMs": startMs, "endMs": startMs, "text": "hello",
        ]
        let data = try! JSONSerialization.data(withJSONObject: json.compactMapValues { $0 })
        return try! JSONDecoder().decode(TranscriptPageResponse.Line.self, from: data)
    }

    func testRealSpeakerNameIsKept() {
        let l = line(speaker: "Dr Rivera", tag: nil, startMs: 1000).asTranscriptLine(index: 0)
        XCTAssertEqual(l.speaker, "Dr Rivera")
    }

    func testPlaceholderSpeakerIsDroppedRatherThanShown() {
        // Diarization is off in production, so the fast path emits a literal
        // "Speaker" for every line. Rendering that on each row would imply an
        // attribution the data does not support.
        let l = line(speaker: "Speaker", tag: nil, startMs: 1000).asTranscriptLine(index: 0)
        XCTAssertTrue(l.speaker.isEmpty)
    }

    func testDiarizationTagBecomesANumberedSpeaker() {
        let l = line(speaker: nil, tag: 2, startMs: 0).asTranscriptLine(index: 0)
        XCTAssertEqual(l.speaker, "Speaker 2")
    }

    func testTimestampIsCarriedForSeeking() {
        let l = line(speaker: nil, tag: nil, startMs: 62_000).asTranscriptLine(index: 4)
        XCTAssertEqual(l.startMs, 62_000)
        XCTAssertEqual(l.time, "1:02")
        XCTAssertEqual(l.index, 4)
    }

    func testMissingTimestampLeavesNoDisplayTime() {
        let l = line(speaker: nil, tag: nil, startMs: nil).asTranscriptLine(index: 0)
        XCTAssertNil(l.startMs)
        XCTAssertTrue(l.time.isEmpty)
    }
}

// MARK: - Audio source resolution
//
// The decision table for where a note's audio comes from. Getting this wrong
// is not cosmetic: offering a player for a scanned PDF hands AVPlayer an
// image, and preferring the remote copy over a local one makes the user wait
// on a network round trip for a file already on disk.

final class AudioAssetResolverTests: XCTestCase {
    private let local = URL(fileURLWithPath: "/tmp/rec.m4a")

    func testLocalFileWinsOverStorage() {
        // AppEnvironment deletes the local file only after a *confirmed*
        // upload, so if it is still there it is the same audio.
        let source = AudioAssetResolver.decide(
            localFileURL: local, storagePath: "recordings/ws/n1.m4a", type: .recording
        )
        XCTAssertEqual(source, .local(local))
    }

    func testLocalFileIsUsedBeforeAnUploadHasHappened() {
        let source = AudioAssetResolver.decide(localFileURL: local, storagePath: nil, type: .recording)
        XCTAssertEqual(source, .local(local))
    }

    func testRemoteWhenOnlyStoragePathExists() {
        let source = AudioAssetResolver.decide(
            localFileURL: nil, storagePath: "recordings/ws/n1.m4a", type: .recording
        )
        XCTAssertEqual(source, .remote(storagePath: "recordings/ws/n1.m4a"))
    }

    func testTypesWithoutAudioNeverResolveToRemote() {
        // These carry a storagePath, but it points at an image or a document.
        for type in [NoteType.scanText, .importPdf, .youtube] {
            let source = AudioAssetResolver.decide(
                localFileURL: nil, storagePath: "scans/ws/n1.pdf", type: type
            )
            XCTAssertEqual(source, AudioSource.none, "\(type) offered a player for a non-audio file")
        }
    }

    func testAudioBearingTypes() {
        for type in [NoteType.recording, .importAudio, .onlineMeeting] {
            XCTAssertTrue(type.hasAudio, "\(type) should have audio")
        }
    }

    func testEmptyStoragePathIsNotAPath() {
        let source = AudioAssetResolver.decide(localFileURL: nil, storagePath: "", type: .recording)
        XCTAssertEqual(source, AudioSource.none)
    }

    func testNoAudioWhenNothingIsAvailable() {
        let source = AudioAssetResolver.decide(localFileURL: nil, storagePath: nil, type: .recording)
        XCTAssertEqual(source, AudioSource.none)
    }
}

// MARK: - Audio session arbitration
//
// One shared AVAudioSession, two claimants configured differently: the
// recorder wants .playAndRecord, the player wants .playback. The invariant is
// that the recorder always wins — interrupted playback is an inconvenience,
// a recording that silently captured nothing is unrecoverable.

@MainActor
final class AudioSessionCoordinatorTests: XCTestCase {
    func testStartsUnowned() {
        XCTAssertEqual(AudioSessionCoordinator().owner, .none)
    }

    func testPlaybackIsRefusedWhileTheRecorderHoldsTheSession() {
        let c = AudioSessionCoordinator()
        c.yieldToRecorder(stopPlayback: {})
        XCTAssertEqual(c.owner, .recorder)
        XCTAssertThrowsError(try c.acquireForPlayback()) { error in
            XCTAssertEqual(error as? AudioSessionError, .recorderActive)
        }
        // The refusal must not have disturbed the recorder's ownership.
        XCTAssertEqual(c.owner, .recorder)
    }

    func testYieldingTearsDownPlaybackFirst() {
        // The teardown has to happen *before* the recorder reconfigures the
        // category — that ordering is the whole point of the coordinator.
        let c = AudioSessionCoordinator()
        try? c.acquireForPlayback()
        var stopped = false
        c.yieldToRecorder { stopped = true }
        XCTAssertTrue(stopped, "playback was not stopped before the recorder took the session")
        XCTAssertEqual(c.owner, .recorder)
    }

    func testYieldingWithNoPlaybackDoesNotCallStop() {
        let c = AudioSessionCoordinator()
        var stopped = false
        c.yieldToRecorder { stopped = true }
        XCTAssertFalse(stopped)
        XCTAssertEqual(c.owner, .recorder)
    }

    func testSessionIsFreeAgainAfterRecording() {
        let c = AudioSessionCoordinator()
        c.yieldToRecorder(stopPlayback: {})
        c.recorderFinished()
        XCTAssertEqual(c.owner, .none)
    }

    func testReleasingPlaybackDoesNotStealTheSessionFromTheRecorder() {
        // A late teardown from a torn-down player must not mark the session
        // free while a recording is running.
        let c = AudioSessionCoordinator()
        c.yieldToRecorder(stopPlayback: {})
        c.releasePlayback()
        XCTAssertEqual(c.owner, .recorder)
    }

    func testRecorderFinishedIsIgnoredWhenThePlayerOwnsTheSession() {
        let c = AudioSessionCoordinator()
        try? c.acquireForPlayback()
        let owner = c.owner
        c.recorderFinished()
        XCTAssertEqual(c.owner, owner)
    }
}

// MARK: - PlaybackSpeed

final class PlaybackSpeedTests: XCTestCase {
    func testCycleGoesFasterFirstThenWrapsToTheSlowOption() {
        XCTAssertEqual(PlaybackSpeed.normal.next(), .fast)
        XCTAssertEqual(PlaybackSpeed.fast.next(), .faster)
        XCTAssertEqual(PlaybackSpeed.faster.next(), .veryFast)
        XCTAssertEqual(PlaybackSpeed.veryFast.next(), .double)
        XCTAssertEqual(PlaybackSpeed.double.next(), .slow)
        XCTAssertEqual(PlaybackSpeed.slow.next(), .normal)
    }

    func testCycleVisitsEverySpeedAndReturns() {
        var seen: [PlaybackSpeed] = []
        var speed = PlaybackSpeed.normal
        for _ in 0..<PlaybackSpeed.allCases.count {
            seen.append(speed)
            speed = speed.next()
        }
        XCTAssertEqual(Set(seen).count, PlaybackSpeed.allCases.count)
        XCTAssertEqual(speed, .normal)
    }

    func testLabelsStayNarrow() {
        XCTAssertEqual(PlaybackSpeed.normal.label, "1x")
        XCTAssertEqual(PlaybackSpeed.double.label, "2x")
        XCTAssertEqual(PlaybackSpeed.fast.label, "1.25x")
        XCTAssertEqual(PlaybackSpeed.faster.label, "1.5x")
        XCTAssertEqual(PlaybackSpeed.slow.label, "0.75x")
    }
}

// MARK: - NoteProcessingStage
//
// The rule under test: a number is shown only when a real one exists. The
// chunked pipeline reports done/total and the client measures its own upload;
// everything else has no fraction, and inventing one would be a lie the user
// could catch by watching it sit still.

final class NoteProcessingStageTests: XCTestCase {
    private func stage(
        _ status: NoteStatus,
        progress: NoteProgress? = nil,
        upload: Int? = nil
    ) -> NoteProcessingStage {
        NoteProcessingStage.from(status: status, progress: progress, uploadPercent: upload)
    }

    func testNoDetailWithoutARealNumber() {
        // Every in-progress status with no chunk counts and no upload in
        // flight — i.e. every short recording, all the way through.
        for status in [NoteStatus.queued, .processing, .chunking, .transcribing, .summarizing] {
            let s = stage(status)
            XCTAssertNil(s.detail, "\(status) invented a detail string")
            XCTAssertEqual(s.fill, .indeterminate, "\(status) claimed a fraction it does not have")
        }
    }

    func testUploadPercentageIsUsedWhenMeasured() {
        let s = stage(.queued, upload: 42)
        XCTAssertEqual(s.phase, .upload)
        XCTAssertEqual(s.fill, .fraction(0.42))
        XCTAssertEqual(s.detail, "42%")
        XCTAssertEqual(s.label, "Uploading audio")
    }

    func testUploadBoundsAreNotTreatedAsProgress() {
        // 0 means nothing has moved; 100 means the bytes are gone but the
        // server has not acknowledged. Neither is progress worth showing.
        XCTAssertNil(stage(.queued, upload: 0).detail)
        XCTAssertNil(stage(.queued, upload: 100).detail)
    }

    func testChunkCountsAreUsedWhenReported() {
        let s = stage(.transcribing, progress: NoteProgress(done: 3, total: 8))
        XCTAssertEqual(s.phase, .transcribe)
        XCTAssertEqual(s.fill, .fraction(3.0 / 8.0))
        XCTAssertEqual(s.detail, "3 of 8")
    }

    func testZeroTotalIsNotAFraction() {
        // total == 0 would divide by zero; it means "not chunked", not "0%".
        let s = stage(.transcribing, progress: NoteProgress(done: 0, total: 0))
        XCTAssertEqual(s.fill, .indeterminate)
        XCTAssertNil(s.detail)
    }

    func testFractionIsClampedIfCountsOvershoot() {
        let s = stage(.transcribing, progress: NoteProgress(done: 9, total: 8))
        XCTAssertEqual(s.fill, .fraction(1))
    }

    func testUploadOutranksStatusWhileBytesAreMoving() {
        // A note can be 'queued' server-side while the client is still
        // uploading; the measured number wins.
        let s = stage(.transcribing, progress: NoteProgress(done: 1, total: 4), upload: 10)
        XCTAssertEqual(s.phase, .upload)
        XCTAssertEqual(s.detail, "10%")
    }

    func testPhasesAdvanceThroughThePipeline() {
        XCTAssertEqual(stage(.queued).completedPhases, 0)
        XCTAssertEqual(stage(.transcribing).completedPhases, 1)
        XCTAssertEqual(stage(.summarizing).completedPhases, 2)
    }

    func testTerminalStatusesAreTotalRatherThanTrapping() {
        XCTAssertEqual(stage(.ready).phase, .ready)
        XCTAssertEqual(stage(.error).phase, .ready)
    }
}

// MARK: - NoteMeta

final class NoteMetaTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_754_000_000)

    func testSeparatorCollapsesAroundMissingPieces() {
        // Size is absent until the player fetches Storage metadata, and
        // duration is nil for imports — the line must not render "· ·".
        let line = NoteMeta.line(createdAt: date, durationSeconds: nil, sizeBytes: nil)
        XCTAssertFalse(line.contains("·"))
        XCTAssertFalse(line.isEmpty)
    }

    func testAllThreePartsJoin() {
        let line = NoteMeta.line(createdAt: date, durationSeconds: 3, sizeBytes: 20_600)
        XCTAssertEqual(line.components(separatedBy: " · ").count, 3)
        XCTAssertTrue(line.hasSuffix("00:03"))
    }

    func testZeroValuesAreOmittedNotShownAsZero() {
        let line = NoteMeta.line(createdAt: date, durationSeconds: 0, sizeBytes: 0)
        XCTAssertFalse(line.contains("00:00"))
        XCTAssertFalse(line.contains("·"))
    }

    func testDurationGainsHoursOnlyWhenNeeded() {
        XCTAssertEqual(NoteMeta.durationText(3), "00:03")
        XCTAssertEqual(NoteMeta.durationText(125), "02:05")
        // A 2-hour meeting reads better than "120:00".
        XCTAssertEqual(NoteMeta.durationText(7200), "2:00:00")
    }

    func testEmptyWhenNothingIsKnown() {
        XCTAssertEqual(NoteMeta.line(createdAt: nil, durationSeconds: nil, sizeBytes: nil), "")
    }
}

// MARK: - TranscriptLine identity
//
// Identity must never be derived from content. The previous
// "speaker|time|text.prefix(48)" id collided on the short utterances a real
// conversation is full of, and duplicate ids in a SwiftUI ForEach are
// undefined behaviour — dropped rows, broken diffing, scroll jumps. These
// tests fail if anyone reintroduces a content-derived id.

final class TranscriptLineIdentityTests: XCTestCase {
    private func note(withTranscript lines: [[String: Any]]) -> Note? {
        Note(id: "n1", data: [
            "title": "t",
            "workspaceId": "workspace_u1",
            "authorId": "u1",
            "status": "ready",
            "type": "recording",
            "createdAt": Note.isoNow(),
            "updatedAt": Note.isoNow(),
            "transcript": lines,
        ])
    }

    func testIdenticalUtterancesRemainDistinct() {
        // Six lines a back-and-forth genuinely produces: the same
        // speaker agreeing repeatedly at the same displayed second.
        let repeated = (0..<6).map { _ in
            ["speaker": "Speaker 1", "text": "Yes.", "time": "0:42"] as [String: Any]
        }
        let parsed = note(withTranscript: repeated)
        XCTAssertEqual(parsed?.transcript?.count, 6)
        XCTAssertEqual(Set(parsed?.transcript?.map(\.id) ?? []).count, 6)
    }

    func testIdentityFollowsPositionNotContent() {
        let parsed = note(withTranscript: [
            ["speaker": "A", "text": "one", "time": "0:01"],
            ["speaker": "B", "text": "two", "time": "0:05"],
        ])
        XCTAssertEqual(parsed?.transcript?.map(\.id), [0, 1])
    }

    func testLongTranscriptHasNoDuplicateIdentities() {
        // Only 12 distinct texts across 600 lines: under the old scheme this
        // produced ~50 collisions per id.
        let lines = (0..<600).map { i in
            ["speaker": "Speaker 1", "text": "line \(i % 12)", "time": "1:00"] as [String: Any]
        }
        let parsed = note(withTranscript: lines)
        XCTAssertEqual(parsed?.transcript?.count, 600)
        XCTAssertEqual(Set(parsed?.transcript?.map(\.id) ?? []).count, 600)
    }

    func testPrefixOfMirroredTranscriptKeepsIdsWhenFullTranscriptArrives() {
        // The mirrored 200 and the full transcript are both ordered by
        // start_ms, so line n keeps id n. That is what lets SwiftUI diff an
        // append instead of a wholesale replacement, preserving scroll
        // position when the full fetch lands.
        let full = (0..<40).map { i in
            ["speaker": "Speaker 1", "text": "line \(i)", "time": "0:0\(i % 10)"] as [String: Any]
        }
        let mirrored = Array(full.prefix(10))
        let mirroredIds = note(withTranscript: mirrored)?.transcript?.map(\.id) ?? []
        let fullIds = note(withTranscript: full)?.transcript?.map(\.id) ?? []
        XCTAssertEqual(mirroredIds, Array(fullIds.prefix(10)))
    }
}

// MARK: - CostModel (parity with src/lib/costs.ts)

final class CostModelTests: XCTestCase {
    func testFormatUsd() {
        // Avoid exact .5-boundary inputs — printf and JS toFixed round those
        // differently, and the value is a labeled estimate, not billed.
        XCTAssertEqual(CostModel.formatUsd(0.12344), "$0.1234")
        XCTAssertEqual(CostModel.formatUsd(0.98765), "$0.9877")
        XCTAssertEqual(CostModel.formatUsd(1.5, decimals: 2), "$1.50")
        XCTAssertEqual(CostModel.formatUsd(0), "$0.0000")
        XCTAssertEqual(CostModel.formatUsd(.nan), "$0.0000")
    }

    func testEstimate() {
        let note = Note(
            id: "n", title: "t", workspaceId: "ws", authorId: "u",
            status: .ready, type: .recording, sourceUrl: nil, duration: 600,
            wordCount: nil, createdAt: Note.isoNow(), updatedAt: Note.isoNow(),
            lastProgressAt: nil,
            summary: Summary(gist: String(repeating: "s", count: 400), actionItems: [], keyDecisions: [], keyPoints: nil),
            transcript: [TranscriptLine(index: 0, speaker: "A", text: String(repeating: "x", count: 4000), time: "")],
            transcriptTruncated: nil, rawText: nil, errorMessage: nil, diagnosticCode: nil,
            storagePath: nil, mimeType: nil, jobId: nil, progress: nil, retryAttempt: nil
        )
        let cost = CostModel.estimate(note: note)
        XCTAssertEqual(cost.durationMinutes, 10, accuracy: 0.001)
        XCTAssertEqual(cost.stt, 0.24, accuracy: 0.0001)                       // 10 min * 0.024
        XCTAssertEqual(cost.llm, 1000.0 / 1_000_000 * 0.075 + 100.0 / 1_000_000 * 0.30, accuracy: 1e-9)
        XCTAssertEqual(cost.embedding, 1000.0 / 1000 * 0.000025, accuracy: 1e-9)
    }
}

// MARK: - StoragePaths (parity with storage.rules)

final class StoragePathsTests: XCTestCase {
    func testPathBuilder() {
        XCTAssertEqual(
            StoragePaths.path(kind: .recording, workspaceId: "workspace_u1", noteId: "abc", ext: "m4a"),
            "recordings/workspace_u1/abc.m4a"
        )
        XCTAssertEqual(
            StoragePaths.path(kind: .importFile, workspaceId: "workspace_u1", noteId: "abc", ext: "mp3"),
            "imports/workspace_u1/abc.mp3"
        )
        XCTAssertEqual(
            StoragePaths.path(kind: .scan, workspaceId: "workspace_u1", noteId: "abc", ext: "pdf"),
            "scans/workspace_u1/abc.pdf"
        )
    }

    func testCaps() {
        // One cap, the server's (/v1/uploads refuses anything over 500 MB).
        XCTAssertEqual(StorageKind.recording.maxBytes, 500 * 1024 * 1024)
        XCTAssertEqual(StorageKind.importFile.maxBytes, 500 * 1024 * 1024)
        XCTAssertEqual(StorageKind.scan.maxBytes, 500 * 1024 * 1024)
    }

    func testWorkspaceId() {
        XCTAssertEqual(workspaceId(forUid: "abc123"), "workspace_abc123")
    }
}

// MARK: - RecordingStore (durable recording lifecycle — PR-i1)

final class RecordingStoreTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("recstore-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    @MainActor
    private func makeStore() -> RecordingStore {
        RecordingStore(directory: tempDir)
    }

    /// Writes a non-empty fake audio file for `url`.
    private func writeAudio(_ url: URL, bytes: Int = 16) throws {
        try Data(repeating: 0xAB, count: bytes).write(to: url)
    }

    @MainActor
    func testMakeRecordingURLIsUniqueAndInDirectory() {
        let store = makeStore()
        let a = store.makeRecordingURL()
        let b = store.makeRecordingURL()
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a.deletingLastPathComponent().path, tempDir.path)
        XCTAssertEqual(a.pathExtension, "aac") // ADTS: a killed recording stays readable
        XCTAssertTrue(a.lastPathComponent.hasPrefix("recording_"))
    }

    @MainActor
    func testAssociateThenLookupByNoteId() throws {
        let store = makeStore()
        let url = store.makeRecordingURL()
        try writeAudio(url)
        store.associate(fileURL: url, noteId: "note-1", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 42)

        let found = store.pendingRecording(forNoteId: "note-1")
        XCTAssertNotNil(found)
        XCTAssertEqual(found?.noteId, "note-1")
        XCTAssertEqual(found?.durationSeconds, 42)
        XCTAssertEqual(found?.mimeType, "audio/mp4")
        XCTAssertEqual(store.audioURL(for: found!).lastPathComponent, url.lastPathComponent)
        XCTAssertNil(store.pendingRecording(forNoteId: "other"))
    }

    @MainActor
    func testRemoveDeletesFileAndSidecar() throws {
        let store = makeStore()
        let url = store.makeRecordingURL()
        try writeAudio(url)
        store.associate(fileURL: url, noteId: "note-2", mimeType: "audio/mp4", ext: "m4a", durationSeconds: nil)
        XCTAssertNotNil(store.pendingRecording(forNoteId: "note-2"))

        store.remove(fileURL: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNil(store.pendingRecording(forNoteId: "note-2"))
        XCTAssertTrue(store.allPending().isEmpty)
    }

    @MainActor
    func testAllPendingIncludesAssociatedAndOrphans() throws {
        let store = makeStore()
        // Associated recording (has a note).
        let associated = store.makeRecordingURL()
        try writeAudio(associated)
        store.associate(fileURL: associated, noteId: "n-assoc", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 10)
        // Orphan: audio file with no sidecar (app died before a note existed).
        let orphan = store.makeRecordingURL()
        try writeAudio(orphan)

        let pending = store.allPending()
        XCTAssertEqual(pending.count, 2)
        XCTAssertEqual(pending.filter { $0.isAssociated }.count, 1)
        let orphanRec = pending.first { !$0.isAssociated }
        XCTAssertNotNil(orphanRec)
        XCTAssertNil(orphanRec?.noteId)
        XCTAssertEqual(orphanRec?.fileName, orphan.lastPathComponent)
    }

    @MainActor
    func testAllPendingSkipsZeroByteFiles() throws {
        let store = makeStore()
        let empty = store.makeRecordingURL()
        try writeAudio(empty, bytes: 0)
        XCTAssertTrue(store.allPending().isEmpty, "zero-byte recordings are not recoverable")
    }

    @MainActor
    func testSidecarSurvivesFreshStoreInstance() throws {
        // Durability: a new store over the same directory (app relaunch) still
        // sees the association written by the previous instance.
        let first = makeStore()
        let url = first.makeRecordingURL()
        try writeAudio(url)
        first.associate(fileURL: url, noteId: "persist-1", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 7)

        let second = RecordingStore(directory: tempDir)
        let found = second.pendingRecording(forNoteId: "persist-1")
        XCTAssertEqual(found?.noteId, "persist-1")
        XCTAssertEqual(found?.durationSeconds, 7)
    }
}

// MARK: - Citation segments (parity with the ChatTab [n] splitter)

final class CitationSegmentTests: XCTestCase {
    @MainActor
    func testSegments() {
        let segments = ChatViewModel.segments(for: "We decided [1] to ship [2].")
        XCTAssertEqual(segments, [
            .text("We decided "), .citation(1), .text(" to ship "), .citation(2), .text("."),
        ])
    }

    @MainActor
    func testNoCitations() {
        XCTAssertEqual(ChatViewModel.segments(for: "plain text"), [.text("plain text")])
    }
}

// MARK: - Timestamp formatting

final class FormattingTests: XCTestCase {
    func testFormatTimestamp() {
        XCTAssertEqual(formatTimestamp(ms: 0), "0:00")
        XCTAssertEqual(formatTimestamp(ms: 61_000), "1:01")
        XCTAssertEqual(formatTimestamp(ms: 3_599_000), "59:59")
    }

    func testFormatTimer() {
        XCTAssertEqual(formatTimer(seconds: 0), "00:00")
        XCTAssertEqual(formatTimer(seconds: 3300), "55:00")
        XCTAssertEqual(formatTimer(seconds: 3600), "60:00")
        XCTAssertEqual(formatTimer(seconds: 7200), "120:00")
    }

    // 4-hour cap (M1: a 3 h meeting and then some); warning pill fires 5 min
    // before. A 4-hour 64 kbps ADTS file (~120 MB with frame headers) must fit
    // the api's one upload cap.
    @MainActor
    func testRecordingCapIsFourHoursWithFiveMinuteWarning() {
        XCTAssertEqual(RecorderService.maxRecordingSeconds, 4 * 3600)
        XCTAssertEqual(RecorderService.warnAfterSeconds, RecorderService.maxRecordingSeconds - 300)
        let capBytes = Int64(Double(RecorderService.maxRecordingSeconds * (64_000 / 8)) * 1.06)
        XCTAssertLessThan(capBytes, 500 * 1024 * 1024) // /v1/uploads' cap
    }
}

// MARK: - Export wire contract

/// `ExportScope.rawValue` is sent straight to `/api/export-note`, which
/// branches on the literals 'summary' / 'transcript' / 'both'
/// (functions/export-note.cjs:70,96,160). Renaming a case would silently
/// change what the server exports rather than failing loudly, so the wire
/// values are pinned here.
final class ExportWireContractTests: XCTestCase {
    func testScopeRawValuesMatchTheServerContract() {
        XCTAssertEqual(ExportScope.summary.rawValue, "summary")
        XCTAssertEqual(ExportScope.transcript.rawValue, "transcript")
        XCTAssertEqual(ExportScope.both.rawValue, "both")
    }

    func testEveryScopeIsCoveredByTheContract() {
        // Guards against a fourth case being added without a server branch.
        XCTAssertEqual(Set(ExportScope.allCases.map(\.rawValue)),
                       ["summary", "transcript", "both"])
    }
}

// MARK: - Summary templates

/// `SummaryTemplate.rawValue` is sent to /api/regenerate-summary and looked up
/// in shared/summary-templates.cjs. The server falls back to `general` for an
/// unknown id rather than erroring — so a mismatch would not fail anywhere, it
/// would silently ignore the user's choice and return a general summary. These
/// pin the ids so that drift is a test failure instead.
final class SummaryTemplateTests: XCTestCase {
    func testWireIdsMatchTheServerTemplates() {
        XCTAssertEqual(SummaryTemplate.general.rawValue, "general")
        // Snake case, not camel — the Swift case name differs from the wire id.
        XCTAssertEqual(SummaryTemplate.actionsOnly.rawValue, "actions_only")
        XCTAssertEqual(SummaryTemplate.salesCall.rawValue, "sales_call")
        XCTAssertEqual(SummaryTemplate.oneOnOne.rawValue, "one_on_one")
        XCTAssertEqual(SummaryTemplate.boardMeeting.rawValue, "board_meeting")
        XCTAssertEqual(SummaryTemplate.clientMeeting.rawValue, "client_meeting")
    }

    func testShipsExactlyTheServerTemplates() {
        XCTAssertEqual(Set(SummaryTemplate.allCases.map(\.rawValue)),
                       ["general", "actions_only", "standup", "interview",
                        "sales_call", "lecture", "one_on_one", "board_meeting",
                        "client_meeting"])
    }

    func testEveryTemplateHasUserFacingCopy() {
        // A template with no blurb renders an empty row in the picker.
        for template in SummaryTemplate.allCases {
            XCTAssertFalse(template.label.isEmpty, "\(template) has no label")
            XCTAssertFalse(template.blurb.isEmpty, "\(template) has no blurb")
            XCTAssertFalse(template.icon.isEmpty, "\(template) has no icon")
        }
    }
}

// MARK: - Export formats

final class ExportFormatTests: XCTestCase {
    func testOnlyDocxIsServerRendered() {
        // PDF and TXT must stay on-device: routing them through the network
        // would make exporting fail offline for no benefit.
        XCTAssertFalse(ExportFormat.pdf.isServerRendered)
        XCTAssertFalse(ExportFormat.txt.isServerRendered)
        XCTAssertTrue(ExportFormat.docx.isServerRendered)
    }

    func testDocxMimeTypeIsTheOOXMLType() {
        // Mail attachments are typed by this string; the generic
        // application/octet-stream would make Word refuse to open it.
        XCTAssertEqual(
            ExportFormat.docx.mimeType,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
    }

    func testEveryFormatHasADistinctExtensionAndMimeType() {
        let exts = ExportFormat.allCases.map(\.ext)
        let mimes = ExportFormat.allCases.map(\.mimeType)
        XCTAssertEqual(Set(exts).count, exts.count, "two formats share a file extension")
        XCTAssertEqual(Set(mimes).count, mimes.count, "two formats share a MIME type")
    }
}

// MARK: - Speaker label reconciliation

/// Regression tests for the double-prefix seen on build 8: a chip reading
/// "Speaker" above text reading "Speaker 1: …", on every line of every short
/// note. The fast path embeds the speaker in the text
/// (services/transcoder/src/fast-path.js:82) while the chip came from a
/// separate field that only ever held the placeholder.
final class SpeakerLabelTests: XCTestCase {
    func testPullsAnEmbeddedSpeakerOutOfTheText() {
        let r = SpeakerLabel.split(speaker: "Speaker", text: "Speaker 1: That's why I got coffee.")
        XCTAssertEqual(r.label, "Speaker 1")
        XCTAssertEqual(r.text, "That's why I got coffee.")
    }

    func testEmbeddedPrefixWinsOverThePlaceholderField() {
        // The stored field says "Speaker"; the text knows it is speaker 2.
        let r = SpeakerLabel.split(speaker: "Speaker", text: "Speaker 2: Okay.")
        XCTAssertEqual(r.label, "Speaker 2")
    }

    func testBareSpeakerPlaceholderRendersNoChip() {
        // A chip reading "Speaker" on every row implies attribution the data
        // does not support.
        XCTAssertEqual(SpeakerLabel.display("Speaker"), "")
        XCTAssertEqual(SpeakerLabel.display("  speaker  "), "")
        XCTAssertEqual(SpeakerLabel.display(""), "")
        XCTAssertEqual(SpeakerLabel.display(nil), "")
    }

    func testKeepsARealName() {
        XCTAssertEqual(SpeakerLabel.display("Dr Rivera"), "Dr Rivera")
        let r = SpeakerLabel.split(speaker: "Dr Rivera", text: "The team ships on Friday.")
        XCTAssertEqual(r.label, "Dr Rivera")
        XCTAssertEqual(r.text, "The team ships on Friday.")
    }

    func testLeavesOrdinaryTextAlone() {
        // Must not eat a line that merely talks about a speaker.
        let r = SpeakerLabel.split(speaker: nil, text: "Speaker fees are due next month.")
        XCTAssertEqual(r.label, "")
        XCTAssertEqual(r.text, "Speaker fees are due next month.")
    }

    func testDoesNotBlankALineThatIsOnlyAPrefix() {
        // Stripping here would leave an empty row with no way to tell why.
        let r = SpeakerLabel.split(speaker: nil, text: "Speaker 1:")
        XCTAssertEqual(r.text, "Speaker 1:")
    }

    func testHandlesSpacingAndCaseVariants() {
        XCTAssertEqual(SpeakerLabel.split(speaker: nil, text: "SPEAKER 3 : Yes.").label, "Speaker 3")
        // A bare "speaker:" prefix is stripped but yields no chip — same rule
        // display() applies, since the word alone attributes nothing.
        XCTAssertEqual(SpeakerLabel.split(speaker: nil, text: "speaker: Mm-hm.").label, "")
        XCTAssertEqual(SpeakerLabel.split(speaker: nil, text: "speaker: Mm-hm.").text, "Mm-hm.")
    }
}

// MARK: - Upload error copy

final class UploadErrorCopyTests: XCTestCase {
    func testTimeoutMessageNamesNoDuration() {
        // The copy used to quote the timeout in minutes, and the two drifted so
        // a long upload reported failure after a duration that had never
        // elapsed. Quoting any duration is now wrong on principle: an upload
        // that keeps making progress is never cancelled, however long it takes.
        let message = UploadError.timedOut.errorDescription ?? ""
        XCTAssertFalse(message.contains("minutes"), "must not quote a duration: \(message)")
        XCTAssertFalse(message.contains("10"))
    }

    func testTimeoutMessageSaysTheRecordingIsSafe() {
        // This is the message a user sees after a failed recording upload. If
        // it does not say the audio was kept, it reads as data loss.
        let message = (UploadError.timedOut.errorDescription ?? "").lowercased()
        XCTAssertTrue(message.contains("saved"))
        XCTAssertTrue(message.contains("upload"))
    }

    func testSizeCopyDistinguishesRecordingsFromImports() {
        XCTAssertTrue((UploadError.tooLarge(limitLabel: "120 MB", isRecording: true)
            .errorDescription ?? "").contains("recording"))
        XCTAssertTrue((UploadError.tooLarge(limitLabel: "500 MB", isRecording: false)
            .errorDescription ?? "").contains("file"))
    }
}

// MARK: - Recording cap warning

final class CapWarningTests: XCTestCase {
    func testReadsInMinutesRatherThanRawSeconds() {
        // Was "298s left — AlgoMinutes auto-stops at 120:00". A user mid-recording
        // should not have to convert seconds or read a timer-formatted cap.
        let m = RecordingView.capWarning(secondsLeft: 298)
        XCTAssertTrue(m.contains("5 minutes"), m)
        XCTAssertFalse(m.contains("298"), m)
        XCTAssertFalse(m.contains("120:00"), m)
    }

    func testDegradesGracefullyInTheFinalMinute() {
        XCTAssertTrue(RecordingView.capWarning(secondsLeft: 30).hasPrefix("Less than a minute"))
        XCTAssertTrue(RecordingView.capWarning(secondsLeft: 0).hasPrefix("Less than a minute"))
    }

    func testStatesTheCapInHumanTerms() {
        XCTAssertTrue(RecordingView.capWarning(secondsLeft: 300).contains("4 hours"))
    }
}

// MARK: - Recording durability

final class RecordingDurabilityTests: XCTestCase {
    func testStorageThresholdLeavesHeadroomForAFourHourRecording() {
        // A 4-hour recording is ~120 MB at 64 kbps mono AAC (ADTS). The threshold
        // has to exceed that with room for the OS, or the check passes and the
        // recording still fills the disk partway through.
        let fourHourEstimate: Int64 = 125 * 1024 * 1024
        XCTAssertGreaterThan(RecorderService.minFreeBytesToRecord, fourHourEstimate)
    }

    func testSalvageThresholdIsAboveBareContainerOverhead() {
        // An AAC container always has header bytes, so `size > 0` is true even
        // for a file with no audio in it — which is why the old
        // `sizeBytes > 0` check let silence through as a valid recording.
        XCTAssertGreaterThan(RecorderService.minSalvageBytes, 1_000)
    }

    func testInsufficientStorageMessageNamesTheNumbers() {
        // A user needs to know how much is free and how much is needed,
        // not just that something went wrong.
        let msg = RecorderService.RecorderError.insufficientStorage(freeMB: 12).errorDescription ?? ""
        XCTAssertTrue(msg.contains("12 MB"), msg)
        XCTAssertTrue(msg.lowercased().contains("free up space"), msg)
    }

    func testFreeDiskReturnsAValueForARealDirectory() {
        let tmp = FileManager.default.temporaryDirectory
        XCTAssertNotNil(RecorderService.freeDiskBytes(at: tmp))
    }
}

// MARK: - Apple sign-in nonce
//
// prepareAppleRequest trapped with EXC_BREAKPOINT the instant the Sign in with
// Apple button was tapped, on every device. The rejection bound was written as
// `UInt8(charset.count * (256 / charset.count))`, and the charset is 64
// characters, so it evaluated to UInt8(256) — an overflow the compiler cannot
// catch because the arithmetic is on Int and only the conversion traps.
//
// It reached TestFlight build 11 because nothing exercised this path: device
// testing signed in with Google, and no test called it. These do.
@MainActor
final class AppleNonceTests: XCTestCase {
    func testPreparingTheRequestDoesNotTrap() {
        // The regression itself. Before the fix this call killed the process,
        // so the assertion is simply that we reach the next line.
        let auth = AuthService()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        auth.prepareAppleRequest(request)
        XCTAssertNotNil(request.nonce, "request must carry the hashed nonce")
        XCTAssertEqual(request.requestedScopes, [.fullName, .email])
    }

    func testRepeatedPreparationIsStable() {
        // A trap that depends on a random byte would show up intermittently,
        // so once is not enough to call this closed.
        let auth = AuthService()
        var seen = Set<String>()
        for _ in 0..<200 {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            auth.prepareAppleRequest(request)
            guard let nonce = request.nonce else { return XCTFail("no nonce") }
            // SHA-256 hex: Firebase rejects the credential if this is malformed.
            XCTAssertEqual(nonce.count, 64)
            XCTAssertTrue(nonce.allSatisfy { $0.isHexDigit && !$0.isUppercase })
            seen.insert(nonce)
        }
        XCTAssertEqual(seen.count, 200, "nonces must not repeat — a reused nonce defeats replay protection")
    }
}

// MARK: - Auto-stop
//
// The recorder now stops itself rather than asking RecordingView to, because a
// backgrounded scene never evaluates body — so a recording that hit the 2-hour
// cap in a pocket kept writing past the 120 MB storage limit and became
// permanently unuploadable.
//
// autoStop() itself needs a live AVAudioRecorder, so what is tested here is the
// part a user actually reads. Each message must name the cause and say
// plainly whether the audio survived.
final class AutoStopMessageTests: XCTestCase {
    private let reasons: [RecorderService.AutoStop.Reason] = [
        .hardCap, .interruptionNotResumable, .sessionReactivationFailed, .routeRecoveryFailed,
    ]

    private func result() -> RecorderService.StopResult {
        RecorderService.StopResult(
            fileURL: URL(fileURLWithPath: "/tmp/x.m4a"),
            sizeBytes: 1_000_000, durationSeconds: 60, recordingFailed: false
        )
    }

    func testEveryReasonSaysWhetherTheAudioSurvived() {
        for reason in reasons {
            let kept = RecorderService.AutoStop(reason: reason, result: result(), at: Date())
            XCTAssertTrue(kept.message.contains("kept"), "\(reason) must say the audio was kept")

            let lost = RecorderService.AutoStop(reason: reason, result: nil, at: Date())
            XCTAssertTrue(
                lost.message.contains("No audio"),
                "\(reason) must say plainly that nothing was captured"
            )
            XCTAssertFalse(
                lost.message.contains("kept"),
                "\(reason) must not promise kept audio when there is none"
            )
        }
    }

    func testEachReasonNamesItsOwnCause() {
        // A user whose recording stopped needs to know whether it was the
        // time limit, a phone call, or the microphone — "recording stopped"
        // alone leaves them wondering if they did it themselves.
        let messages = reasons.map {
            RecorderService.AutoStop(reason: $0, result: result(), at: Date()).message
        }
        XCTAssertEqual(Set(messages).count, reasons.count, "reasons must not share copy")

        func message(_ r: RecorderService.AutoStop.Reason) -> String {
            RecorderService.AutoStop(reason: r, result: result(), at: Date()).message
        }
        XCTAssertTrue(message(.hardCap).contains("4-hour"))
        XCTAssertTrue(message(.interruptionNotResumable).lowercased().contains("another app"))
        XCTAssertTrue(message(.routeRecoveryFailed).lowercased().contains("microphone"))
    }

    func testMessagesCarryNoInternalVocabulary() {
        for reason in reasons {
            for result in [self.result(), nil] {
                let m = RecorderService.AutoStop(reason: reason, result: result, at: Date()).message
                for leak in ["nil", "AVAudio", "session", "route", "autoStop", "Error"] {
                    XCTAssertFalse(m.contains(leak), "\(reason) leaked \"\(leak)\": \(m)")
                }
            }
        }
    }
}

// MARK: - RecordingValidator
//
// A recording orphaned by a force-quit was accepted on `size > 0` alone and
// offered to the user as "Upload it". AVAudioRecorder writes the moov atom at
// close, so a file that was never finalised has no sample tables — unplayable,
// unrepairable, and silently useless once uploaded.
//
// These build a real AAC .m4a on the simulator and then truncate it, which is
// what an unfinalised recording looks like. No microphone permission and no
// device needed, so the check that guards a meeting is actually
// exercised in CI rather than trusted.
final class RecordingValidatorTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("validator-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    /// A genuine AAC .m4a of `seconds` length, written and closed properly.
    private func writeValidRecording(seconds: Double) throws -> URL {
        let url = scratch.appendingPathComponent("good.m4a")
        let sampleRate = 44_100.0
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]
        // Scoped so the file is flushed and the moov atom written on dealloc.
        do {
            let file = try AVAudioFile(forWriting: url, settings: settings)
            let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
            let frames = AVAudioFrameCount(sampleRate * seconds)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
            buffer.frameLength = frames
            // A tone rather than silence: silence can encode to almost nothing,
            // which would make the truncation test trivially pass.
            let samples = buffer.floatChannelData![0]
            for i in 0..<Int(frames) {
                samples[i] = 0.4 * sinf(2 * .pi * 440 * Float(i) / Float(sampleRate))
            }
            try file.write(from: buffer)
        }
        return url
    }

    func testAcceptsAFinalisedRecordingAndReportsItsLength() async throws {
        let url = try writeValidRecording(seconds: 3)
        let verdict = await RecordingValidator.validate(url)
        XCTAssertTrue(verdict.isPlayable)
        // The duration feeds the note, which sizes the stuck-note watchdog.
        XCTAssertEqual(verdict.durationSeconds ?? 0, 3, accuracy: 1)
    }

    func testRejectsATruncatedRecording() async throws {
        // The regression. Cutting the tail removes the moov atom, which is
        // exactly what a force-quit mid-recording leaves behind.
        let url = try writeValidRecording(seconds: 3)
        let whole = try Data(contentsOf: url)
        let truncated = scratch.appendingPathComponent("truncated.m4a")
        try whole.prefix(Int(Double(whole.count) * 0.6)).write(to: truncated)

        let size = try FileManager.default.attributesOfItem(atPath: truncated.path)[.size] as! Int64
        XCTAssertGreaterThan(size, RecorderService.minSalvageBytes,
                             "must be big enough that the old size-only check would have passed it")

        let verdict = await RecordingValidator.validate(truncated)
        XCTAssertFalse(verdict.isPlayable, "a file with no moov atom must never be offered for upload")
        XCTAssertNil(verdict.durationSeconds)
    }

    func testRejectsAFileWhoseHeaderIsGone() async throws {
        // The other realistic unfinalised shape: the header never got written,
        // leaving audio bytes with nothing describing them.
        let url = try writeValidRecording(seconds: 3)
        let whole = try Data(contentsOf: url)
        let headerless = scratch.appendingPathComponent("headerless.m4a")
        // Drop the leading ftyp+moov region; keep the back half, which is mdat.
        try whole.suffix(whole.count / 2).write(to: headerless)

        let verdict = await RecordingValidator.validate(headerless)
        XCTAssertFalse(verdict.isPlayable)
    }

    func testRejectsGarbageAndMissingFiles() async throws {
        let garbage = scratch.appendingPathComponent("garbage.m4a")
        try Data(repeating: 0xAB, count: 40_000).write(to: garbage)
        let g = await RecordingValidator.validate(garbage)
        XCTAssertFalse(g.isPlayable)

        let missing = await RecordingValidator.validate(scratch.appendingPathComponent("nope.m4a"))
        XCTAssertFalse(missing.isPlayable)
    }

    func testRejectsARecordingTooShortToBeAMeeting() async throws {
        let url = try writeValidRecording(seconds: 0.2)
        let verdict = await RecordingValidator.validate(url)
        XCTAssertFalse(verdict.isPlayable, "a fraction of a second is container overhead, not audio")
    }

    func testDamagedMessageNeverOffersDeletionOrLeaksInternals() {
        let m = RecordingValidator.damagedMessage
        XCTAssertFalse(m.lowercased().contains("delete it now"))
        for leak in ["moov", "atom", "AVAsset", "nil", "m4a"] {
            XCTAssertFalse(m.contains(leak), "leaked \"\(leak)\"")
        }
        XCTAssertTrue(m.lowercased().contains("still saved"), "must say the file is not gone")
    }
}

// MARK: - RecorderWatchdog
//
// AVAudioSession posts .began when a call arrives and .ended when it finishes,
// and the recorder resumed ONLY in the .ended branch. If .ended never arrived,
// the recorder stayed paused forever while the screen read "Recording in
// progress" — the user finished a recording believing it was captured.
//
// These pin the timing decisions, because the constants encode a real
// trade-off: warn early (nothing is being captured, and every second they do
// not know is a second they think is recorded) but give up late (stopping
// preserves no audio that waiting would lose, and an early stop just forces the
// recording into two notes when the call ends).
final class RecorderWatchdogTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func decide(
        diverged: TimeInterval?,
        sinceLastResume: TimeInterval? = nil,
        warned: Bool = false,
        recorderRunning: Bool = false,
        weThink: Bool = true
    ) -> RecorderWatchdog.Decision {
        RecorderWatchdog.decide(
            weThinkWeAreRecording: weThink,
            recorderIsRunning: recorderRunning,
            divergedSince: diverged.map { t0.addingTimeInterval(-$0) },
            lastResumeAttempt: sinceLastResume.map { t0.addingTimeInterval(-$0) },
            alreadyWarned: warned,
            now: t0
        )
    }

    func testHealthyRecordingIsLeftAlone() {
        XCTAssertEqual(decide(diverged: nil, recorderRunning: true), .doNothing)
        XCTAssertEqual(decide(diverged: 600, recorderRunning: true), .doNothing,
                       "a running recorder is fine no matter what the stale state says")
    }

    func testNotRecordingIsLeftAlone() {
        XCTAssertEqual(decide(diverged: 600, weThink: false), .doNothing)
    }

    func testFirstTickOfDivergenceOnlyStartsTheClock() {
        XCTAssertEqual(decide(diverged: nil), .doNothing)
    }

    func testShortInterruptionsAreIgnored() {
        // Siri, a notification chime — these self-resolve. Acting on them would
        // make the watchdog the problem.
        XCTAssertEqual(decide(diverged: 1), .doNothing)
        XCTAssertEqual(decide(diverged: RecorderWatchdog.graceSeconds - 0.1), .doNothing)
    }

    func testResumesOnceGraceHasPassed() {
        let d = decide(diverged: RecorderWatchdog.graceSeconds + 0.1)
        XCTAssertTrue(d.attemptResume)
        XCTAssertFalse(d.giveUp)
    }

    func testResumeAttemptsAreSpacedOut() {
        // setActive(true) fails while another app holds the session, so retrying
        // every tick would be 10 pointless calls a second.
        XCTAssertFalse(decide(diverged: 10, sinceLastResume: 1).attemptResume)
        XCTAssertTrue(decide(diverged: 10, sinceLastResume: RecorderWatchdog.resumeRetrySeconds).attemptResume)
    }

    func testWarnsBeforeGivingUpAndOnlyOnce() {
        XCTAssertFalse(decide(diverged: RecorderWatchdog.warnAfterSeconds - 1).warnUser)
        XCTAssertTrue(decide(diverged: RecorderWatchdog.warnAfterSeconds).warnUser)
        XCTAssertFalse(decide(diverged: RecorderWatchdog.warnAfterSeconds + 60, warned: true).warnUser,
                       "the user should be told once, not every tick")
    }

    func testKeepsTryingWellPastTheWarning() {
        // The load-bearing trade-off: a 4-minute call must not end the recording,
        // because a resume still recovers it into one note.
        let d = decide(diverged: 240, sinceLastResume: 10, warned: true)
        XCTAssertTrue(d.attemptResume)
        XCTAssertFalse(d.giveUp)
    }

    func testGivesUpEventually() {
        let d = decide(diverged: RecorderWatchdog.giveUpSeconds, warned: true)
        XCTAssertTrue(d.giveUp)
        XCTAssertFalse(d.attemptResume, "no point retrying on the way out")
    }

    func testWarningIsHonestAboutTheConsequence() {
        // "Paused" on its own reads as harmless; it is not.
        let n = RecorderWatchdog.divergedNotice.lowercased()
        XCTAssertTrue(n.contains("not being captured"))
        XCTAssertTrue(n.contains("microphone"))
    }

    func testThresholdsAreOrderedSensibly() {
        XCTAssertLessThan(RecorderWatchdog.graceSeconds, RecorderWatchdog.warnAfterSeconds)
        XCTAssertLessThan(RecorderWatchdog.warnAfterSeconds, RecorderWatchdog.giveUpSeconds)
        XCTAssertLessThan(RecorderWatchdog.resumeRetrySeconds, RecorderWatchdog.warnAfterSeconds)
    }
}


// MARK: - UploadStallPolicy
//
// The upload timeout was wall-clock: ten minutes after the transfer began,
// cancel. A ~57 MB two-hour recording on a clinic uplink can legitimately take
// longer, and because the local file survives and resumePendingUploads restarts
// from byte zero on the next foreground, the same upload was cancelled again at
// ten minutes, forever. The recording never left the device and nothing
// about it looked like an error.
final class UploadStallPolicyTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 2_000_000)

    private func verdict(afterSeconds: TimeInterval, lastProgressSecondsAgo: TimeInterval)
        -> UploadStallPolicy.Verdict {
        let now = start.addingTimeInterval(afterSeconds)
        return UploadStallPolicy.evaluate(
            startedAt: start,
            lastProgressAt: now.addingTimeInterval(-lastProgressSecondsAgo),
            now: now
        )
    }

    func testASlowButMovingUploadIsNeverCancelled() {
        // The regression. Thirty minutes in, still progressing — under the old
        // wall-clock rule this had already been killed twice.
        XCTAssertEqual(verdict(afterSeconds: 1800, lastProgressSecondsAgo: 5), .healthy)
    }

    func testAStalledUploadIsCancelled() {
        XCTAssertEqual(
            verdict(afterSeconds: 300, lastProgressSecondsAgo: UploadStallPolicy.stallSeconds),
            .stalled
        )
    }

    func testABriefPauseIsToleratedForAHandover() {
        // Switching from office wifi to cellular goes quiet and recovers.
        XCTAssertEqual(verdict(afterSeconds: 300, lastProgressSecondsAgo: 30), .healthy)
    }

    func testTheCeilingStillCatchesAnUploadThatNeverFinishes() {
        XCTAssertEqual(
            verdict(afterSeconds: UploadStallPolicy.hardCeilingSeconds, lastProgressSecondsAgo: 1),
            .exceededCeiling
        )
    }

    func testThresholdsAreOrderedSensibly() {
        XCTAssertLessThan(UploadStallPolicy.checkIntervalSeconds, UploadStallPolicy.stallSeconds)
        XCTAssertLessThan(UploadStallPolicy.stallSeconds, UploadStallPolicy.hardCeilingSeconds)
    }
}
