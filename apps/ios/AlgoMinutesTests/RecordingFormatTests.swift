import XCTest
@testable import AlgoMinutes

/// New recordings are ADTS AAC (`.aac`), which a crash can't make unreadable;
/// recordings from older builds (`.m4a`) are still found and uploaded as MP4.
@MainActor
final class RecordingFormatTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("recfmt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testNewRecordingsAreADTS() {
        let store = RecordingStore(directory: dir)
        XCTAssertEqual(store.makeRecordingURL().pathExtension, "aac")
        XCTAssertEqual(RecordingFormat.mimeType(forExt: "aac"), "audio/aac")
        XCTAssertEqual(RecordingFormat.mimeType(forExt: "M4A"), "audio/mp4")
    }

    /// An orphan (the app died before a note existed) is offered back with the
    /// type its bytes are, whichever build recorded it.
    func testOrphansOfEitherFormatAreRecoveredWithTheirOwnType() throws {
        let store = RecordingStore(directory: dir)
        let adts = dir.appendingPathComponent("recording_new.aac")
        let mp4 = dir.appendingPathComponent("recording_old.m4a")
        let other = dir.appendingPathComponent("import_x.aac")
        for url in [adts, mp4, other] { try Data(repeating: 0xFF, count: 32).write(to: url) }
        let found = Dictionary(uniqueKeysWithValues: store.allPending().map { ($0.fileName, $0) })
        XCTAssertEqual(Set(found.keys), ["recording_new.aac", "recording_old.m4a"])
        XCTAssertEqual(found["recording_new.aac"]?.mimeType, "audio/aac")
        XCTAssertEqual(found["recording_new.aac"]?.ext, "aac")
        XCTAssertEqual(found["recording_old.m4a"]?.mimeType, "audio/mp4")
    }
}
