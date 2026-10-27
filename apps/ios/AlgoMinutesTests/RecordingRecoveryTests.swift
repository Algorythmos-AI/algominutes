import XCTest
@testable import AlgoMinutes

/// Recovering a recording that never confirmed its upload (Home › "Not yet uploaded" › Upload, and every launch).
///
/// Production, 2026-10-27, build 76: Upload on a recording left by the staging build sent nothing to the server
/// and showed nothing. The Staging and Release builds share a bundle id, so a recording made against one backend
/// can be found by the other, still pointing at the first one's note. A recording now remembers the Firebase
/// project it was made for; one from another backend becomes a new note here, never a retry into a note this
/// backend has never seen.
@MainActor
final class RecordingRecoveryTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("recording-recovery-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
    }

    private func recording(noteId: String? = "n1", projectId: String? = nil) -> RecordingStore.PendingRecording {
        var r = RecordingStore.PendingRecording(
            recordingId: "r", fileName: "recording_r.m4a", mimeType: "audio/mp4", ext: "m4a",
            durationSeconds: 23, noteId: noteId, createdAt: Date()
        )
        r.projectId = projectId
        return r
    }

    func testARecordingRemembersTheBackendItWasMadeFor() throws {
        let store = RecordingStore(directory: tempDir, currentProjectId: { "algominutes-staging" })
        let url = store.makeRecordingURL()
        try Data(repeating: 0xAB, count: 16).write(to: url)
        store.associate(fileURL: url, noteId: "n1", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 23)
        XCTAssertEqual(store.pendingRecording(forNoteId: "n1")?.projectId, "algominutes-staging")
    }

    func testAnOldSidecarHasNoBackendAndStillDecodes() throws {
        let json = #"{"recordingId":"r","fileName":"recording_x.m4a","mimeType":"audio/mp4","ext":"m4a","noteId":"n1","createdAt":0}"#
        let decoded = try JSONDecoder().decode(RecordingStore.PendingRecording.self, from: Data(json.utf8))
        XCTAssertNil(decoded.projectId)
        XCTAssertEqual(decoded.noteId, "n1")
    }

    func testTheRecoveryPlan() {
        let prod = "algominutes-production"
        XCTAssertEqual(RecoveryPlan.decide(recording(projectId: prod), fileExists: true, currentProjectId: prod), .reupload(noteId: "n1"))
        XCTAssertEqual(
            RecoveryPlan.decide(recording(projectId: "algominutes-staging"), fileExists: true, currentProjectId: prod),
            .newNote(fromOtherBackend: true)
        )
        // Made before recordings were stamped: not guessed at. The server answers a note id it doesn't know with a
        // 404, which reupload already turns into a new note.
        XCTAssertEqual(RecoveryPlan.decide(recording(projectId: nil), fileExists: true, currentProjectId: prod), .reupload(noteId: "n1"))
        XCTAssertEqual(RecoveryPlan.decide(recording(projectId: "algominutes-staging"), fileExists: true, currentProjectId: nil), .reupload(noteId: "n1"))
        XCTAssertEqual(RecoveryPlan.decide(recording(noteId: nil, projectId: prod), fileExists: true, currentProjectId: prod), .newNote(fromOtherBackend: false))
        XCTAssertEqual(RecoveryPlan.decide(recording(projectId: prod), fileExists: false, currentProjectId: prod), .gone)
    }

    func testDetachingForgetsTheOtherBackendsNoteAndSession() throws {
        let store = RecordingStore(directory: tempDir, currentProjectId: { "algominutes-production" })
        let url = store.makeRecordingURL()
        try Data(repeating: 0xAB, count: 16).write(to: url)
        var staging = recording(projectId: "algominutes-staging")
        staging.fileName = url.lastPathComponent
        staging.uploadId = "u-staging"
        staging.uploadSessionUri = "https://storage.googleapis.com/staging-session"
        staging.state = .failed
        staging.lastError = "old"
        store.write(staging)

        store.detachFromOtherBackend(fileName: url.lastPathComponent)

        let reloaded = RecordingStore(directory: tempDir).allPending().first { $0.fileName == url.lastPathComponent }
        XCTAssertNotNil(reloaded, "the bytes and their sidecar stay: only the other backend's ids go")
        XCTAssertNil(reloaded?.noteId)
        XCTAssertNil(reloaded?.uploadId)
        XCTAssertNil(reloaded?.uploadSessionUri)
        XCTAssertEqual(reloaded?.state, .recorded)
        XCTAssertNil(reloaded?.lastError)
        XCTAssertEqual(reloaded?.projectId, "algominutes-production")
    }

    func testARefusalIsKeptOnTheRecordingSoTheListCanShowIt() throws {
        let store = RecordingStore(directory: tempDir)
        let url = store.makeRecordingURL()
        try Data(repeating: 0xAB, count: 16).write(to: url)
        store.associate(fileURL: url, noteId: "n1", mimeType: "audio/mp4", ext: "m4a", durationSeconds: 23)
        store.setUploadState(fileName: url.lastPathComponent, state: .failed, lastError: .some("Please sign in to do that."))
        let reloaded = store.pendingRecording(forNoteId: "n1")
        XCTAssertEqual(reloaded?.state, .failed)
        XCTAssertEqual(reloaded?.lastError, "Please sign in to do that.")
    }
}
