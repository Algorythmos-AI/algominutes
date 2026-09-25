import XCTest
@testable import AlgoMinutes

/// A note deleted while its recording still waited on this device: deleting it
/// here removes the recording, and one deleted elsewhere is kept as a new note
/// instead of being retried into the server's 404 on every foreground.
@MainActor
final class DeletedNoteRecordingTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deleted-note-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    private func recording(in store: RecordingStore, noteId: String) throws -> URL {
        let url = store.makeRecordingURL(ext: "aac")
        try Data(repeating: 0xAB, count: 16).write(to: url)
        store.associate(fileURL: url, noteId: noteId, mimeType: "audio/aac", ext: "aac", durationSeconds: 60)
        return url
    }

    func testTheUploadSessionsOnly404IsADeletedNote() {
        guard case UploadError.noteGone = BackgroundUploadService.sessionError(APIError.http(status: 404, message: "Note not found")) else {
            return XCTFail("a 404 from POST /v1/uploads should be noteGone")
        }
        guard case APIError.http(status: 503, _) = BackgroundUploadService.sessionError(APIError.http(status: 503, message: nil)) else {
            return XCTFail("anything else passes through")
        }
        guard case APIError.notSignedIn = BackgroundUploadService.sessionError(APIError.notSignedIn) else {
            return XCTFail("anything else passes through")
        }
        XCTAssertNotNil(UploadError.noteGone.errorDescription)
    }

    func testDeletingANoteRemovesItsWaitingRecordingOnly() throws {
        let store = RecordingStore(directory: tempDir)
        let gone = try recording(in: store, noteId: "n1")
        let kept = try recording(in: store, noteId: "n2")

        XCTAssertTrue(store.removeRecording(forNoteId: "n1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: gone.path))
        XCTAssertNil(store.pendingRecording(forNoteId: "n1"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
        XCTAssertNotNil(store.pendingRecording(forNoteId: "n2"))
        XCTAssertFalse(store.removeRecording(forNoteId: "n1"))
    }

    func testKeepingARecordingAsANewNoteForgetsTheOldNoteAndItsSession() throws {
        let store = RecordingStore(directory: tempDir)
        let url = try recording(in: store, noteId: "n-deleted")
        store.setUploadSession(fileName: url.lastPathComponent, uploadId: "u-old", sessionUri: "https://storage.googleapis.com/old")

        store.associate(fileURL: url, noteId: "n-new", mimeType: "audio/aac", ext: "aac", durationSeconds: 60)

        XCTAssertNil(store.pendingRecording(forNoteId: "n-deleted"))
        let moved = store.pendingRecording(forNoteId: "n-new")
        XCTAssertEqual(moved?.fileName, url.lastPathComponent)
        XCTAssertNil(moved?.uploadId)
        XCTAssertNil(moved?.uploadSessionUri)
    }
}
