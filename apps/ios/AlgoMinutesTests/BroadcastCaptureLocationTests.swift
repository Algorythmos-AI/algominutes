import AVFoundation
import XCTest
@testable import AlgoMinutes

/// 2026-10-29: a real broadcast's writer couldn't start at the App Group container's root on iOS 27
/// (NSURLErrorDomain -1100 < OSStatus -17508). The extension now opens its capture in a directory it creates first
/// (BroadcastCaptureWriter.open, captureDirectories), falling back in order and recording every attempt; the app
/// claims by the absolute path the extension reports, wherever that is, including captures left at the old root.
@MainActor
final class BroadcastCaptureLocationTests: XCTestCase {
    private var dir: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("bloc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "test.broadcast.location.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func fileName() -> String { "broadcast_\(UUID().uuidString).m4a" }

    /// A few seconds of ReplayKit-shaped audio on both tracks, finished.
    private func record(_ capture: BroadcastCaptureWriter, seconds: Double = 3) async throws {
        var time = 0.0, frame = 0
        while time < seconds {
            for (shape, track) in [(BroadcastReplayKitBufferTests.Shape.appBigEndian44, BroadcastCaptureWriter.Track.app),
                                   (.mic48, .mic)] {
                let input = track == .app ? capture.appInput : capture.micInput
                var waits = 0
                while !input.isReadyForMoreMediaData, waits < 500 {
                    try await Task.sleep(nanoseconds: 2_000_000)
                    waits += 1
                }
                let buffer = try BroadcastReplayKitBufferTests.buffer(shape, frames: 1_024, startFrame: frame, at: time)
                XCTAssertTrue(capture.append(buffer, to: track), capture.diagnostic(stage: "append"))
            }
            frame += 1_024
            time += 1_024.0 / 44_100
        }
        let completed = await withCheckedContinuation { done in capture.finish { done.resume(returning: $0) } }
        XCTAssertTrue(completed, capture.diagnostic(stage: "finish"))
    }

    private func claim(_ path: String) async -> BroadcastHandoff.Pickup {
        defaults.set("finished", forKey: "state")
        defaults.set(path, forKey: "completedBroadcastFile")
        let handoff = BroadcastHandoff(store: RecordingStore(directory: dir.appendingPathComponent("recordings")), defaults: defaults)
        return await handoff.claim()
    }

    /// In an empty container (as a fresh install's is), the capture's directory is created first and the writer
    /// starts there, and the app claims the capture from it.
    func testTheCaptureDirectoryIsCreatedFirstAndClaimed() async throws {
        let container = dir.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        let opened = BroadcastCaptureWriter.open(inContainer: container, fileName: fileName())
        let capture = try XCTUnwrap(opened.capture, opened.attempts.joined(separator: " "))
        let url = try XCTUnwrap(opened.url)
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL.path,
                       container.appendingPathComponent("Library/Application Support/Broadcasts").standardizedFileURL.path)
        XCTAssertEqual(opened.attempts, ["AS/Broadcasts:d0,f0,w0"])
        XCTAssertTrue(capture.diagnostic(stage: "test").contains("\"loc\":[\"AS\\/Broadcasts:d0,f0,w0\"]"), capture.diagnostic(stage: "test"))
        try await record(capture)
        let result = await claim(url.path)
        guard case .ready(_, let seconds) = result else { return XCTFail("not claimed: \(result)") }
        XCTAssertGreaterThan(seconds, 0)
    }

    /// A location that can't be used is recorded and the next one tried.
    func testALocationThatCantBeCreatedFallsBackToTheNext() async throws {
        let container = dir.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        // A file where Library should be: no directory can be made under it.
        try Data([0]).write(to: container.appendingPathComponent("Library"))
        let opened = BroadcastCaptureWriter.open(inContainer: container, fileName: fileName())
        XCTAssertEqual(opened.attempts.count, 3, opened.attempts.joined(separator: " "))
        XCTAssertTrue(opened.attempts[0].hasPrefix("AS/Broadcasts:d"), opened.attempts[0])
        XCTAssertFalse(opened.attempts[0].hasPrefix("AS/Broadcasts:d0"), opened.attempts[0])
        XCTAssertEqual(opened.attempts[2], "root:d0,f0,w0")
        let capture = try XCTUnwrap(opened.capture)
        XCTAssertEqual(opened.url?.deletingLastPathComponent().standardizedFileURL.path, container.standardizedFileURL.path)
        capture.writer.cancelWriting()
    }

    /// No location in the container works: the extension's own temporary directory is the last resort.
    func testTheFallbackOutsideTheContainerIsTheLastResort() async throws {
        let container = dir.appendingPathComponent("container", isDirectory: true)
        try Data([0]).write(to: container) // a file, not a directory: nothing can be made in it
        let fallback = dir.appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: fallback, withIntermediateDirectories: true)
        let opened = BroadcastCaptureWriter.open(inContainer: container, fileName: fileName(), fallback: fallback)
        XCTAssertEqual(opened.attempts.count, 4, opened.attempts.joined(separator: " "))
        XCTAssertEqual(opened.attempts.last, "tmp:d0,f0,w0")
        let capture = try XCTUnwrap(opened.capture)
        XCTAssertEqual(opened.url?.deletingLastPathComponent().standardizedFileURL.path, fallback.standardizedFileURL.path)
        capture.writer.cancelWriting()
    }

    /// The real App Group container, from the app's process (the extension's can't be run here): the capture
    /// directory can be created and written. Not proof for the extension, whose sandbox differs; the device run is.
    func testTheRealAppGroupContainerTakesACapture() async throws {
        let container = try XCTUnwrap(
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BroadcastHandoff.appGroupID),
            "no App Group container for this build")
        let opened = BroadcastCaptureWriter.open(inContainer: container, fileName: fileName())
        let capture = try XCTUnwrap(opened.capture, opened.attempts.joined(separator: " "))
        let url = try XCTUnwrap(opened.url)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertEqual(opened.attempts.first, "AS/Broadcasts:d0,f0,w0", opened.attempts.joined(separator: " "))
        try await record(capture)
        let tracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 2)
    }

    /// A capture an older extension left at the container's root is claimed like any other: by its path.
    func testACaptureAtTheOldRootLocationIsStillClaimed() async throws {
        let container = dir.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        let opened = BroadcastCaptureWriter.open(inContainer: container, fileName: fileName(), directories: [""])
        let capture = try XCTUnwrap(opened.capture, opened.attempts.joined(separator: " "))
        let url = try XCTUnwrap(opened.url)
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL.path, container.standardizedFileURL.path)
        try await record(capture)
        let result = await claim(url.path)
        guard case .ready = result else { return XCTFail("not claimed: \(result)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
