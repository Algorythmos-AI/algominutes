import XCTest
@testable import AlgoMinutes

/// A recording remembers its upload session (POST /v1/uploads) in its sidecar,
/// so a retry continues that session instead of starting a new one mid-file.
@MainActor
final class UploadSessionMemoryTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("upload-session-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    func testRemembersAndForgetsTheSession() throws {
        let store = RecordingStore(directory: tempDir)
        let url = store.makeRecordingURL()
        try Data(repeating: 0xAB, count: 16).write(to: url)
        store.associate(fileURL: url, noteId: "n1", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 60)
        XCTAssertNil(store.pendingRecording(forNoteId: "n1")?.uploadId)

        store.setUploadSession(fileName: url.lastPathComponent, uploadId: "u-1", sessionUri: "https://storage.googleapis.com/s")
        let reloaded = RecordingStore(directory: tempDir).pendingRecording(forNoteId: "n1")
        XCTAssertEqual(reloaded?.uploadId, "u-1")
        XCTAssertEqual(reloaded?.uploadSessionUri, "https://storage.googleapis.com/s")

        store.setUploadSession(fileName: url.lastPathComponent, uploadId: nil, sessionUri: nil)
        XCTAssertNil(store.pendingRecording(forNoteId: "n1")?.uploadId)
    }

    func testAnOldSidecarWithoutTheSessionKeysStillDecodes() throws {
        let json = #"{"recordingId":"r","fileName":"recording_x.m4a","mimeType":"audio/mp4","ext":"m4a","noteId":"n1","createdAt":0}"#
        let decoded = try JSONDecoder().decode(RecordingStore.PendingRecording.self, from: Data(json.utf8))
        XCTAssertNil(decoded.uploadId)
        XCTAssertNil(decoded.uploadSessionUri)
        XCTAssertEqual(decoded.state, .recorded)
    }
}
