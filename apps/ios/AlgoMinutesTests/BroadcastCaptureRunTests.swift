import AVFoundation
import XCTest
@testable import AlgoMinutes

/// 2026-10-29, after the location fix: three real broadcasts (no call 48 s; WhatsApp calls 33 s and 27 s) all ended
/// with the App Group still at state "recording", the heartbeat stopped and no extension process: the finish never
/// reported. The extension now finishes synchronously (bounded) in broadcastFinished; these pin what that relies on
/// from the capture (memory that doesn't grow with the length of a call, a finish that completes while appends go on
/// on another thread), the per-heartbeat stats that tell a silent capture from a failing one, and that a capture
/// whose extension died is kept for the app when the next broadcast starts.
@MainActor
final class BroadcastCaptureRunTests: XCTestCase {
    private var dir: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("brun-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "test.broadcast.run.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private typealias RK = BroadcastReplayKitBufferTests

    private func newCapture() throws -> (BroadcastCaptureWriter, URL) {
        let url = dir.appendingPathComponent("broadcast_\(UUID().uuidString).m4a")
        let capture = try BroadcastCaptureWriter.make(url: url)
        XCTAssertTrue(capture.start(), capture.diagnostic(stage: "start"))
        return (capture, url)
    }

    /// Appends `seconds` of ReplayKit-shaped audio from `time`, app and microphone interleaved, at most about 10
    /// times faster than real time (faster, an iPhone 11's encoders fall behind and memory measures their backlog). The mic
    /// is at `micAmplitude` (0: digital silence). Returns where it stopped.
    nonisolated private static func feed(_ capture: BroadcastCaptureWriter, from time: Double, seconds: Double,
                                         micAmplitude: Double = 0.25) throws -> Double {
        var t = time
        var micTime = time
        while t < time + seconds {
            try autoreleasepool {
                let app = try RK.buffer(.appBigEndian44, frames: 1_024, startFrame: Int(t * 44_100), at: t)
                guard capture.append(app, to: .app) else { throw RK.SampleError(what: capture.diagnostic(stage: "append")) }
                t += 1_024.0 / 44_100
                while micTime < t {
                    let mic = try RK.buffer(.mic48, frames: 1_024, startFrame: Int(micTime * 48_000), at: micTime, amplitude: micAmplitude)
                    guard capture.append(mic, to: .mic) else { throw RK.SampleError(what: capture.diagnostic(stage: "append")) }
                    micTime += 1_024.0 / 48_000
                }
            }
            usleep(2_300) // 23 ms of audio per ~2.3 ms: about 10x real time
        }
        return t
    }

    /// Waits until the writer has caught up with what it was given (the file stops growing for half a second, at
    /// most 6 s), so a measurement after it counts what the capture keeps, not the encoders' backlog.
    nonisolated private static func drain(_ url: URL) {
        func size() -> Int { ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int) ?? 0 }
        var last = size()
        var stableSince = Date()
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            usleep(100_000)
            let now = size()
            if now != last { last = now; stableSince = Date() } else if Date().timeIntervalSince(stableSince) >= 1.5 { return }
        }
    }

    /// Five minutes of a call through the capture, in 30-second stretches each followed by a drain: after a minute of
    /// warm-up the footprint doesn't grow with the call (the extension's limit is ~50 MB). Measured after draining
    /// because the feed outruns real time: on the iPhone 11 an undrained feed measured the AAC encoders' backlog
    /// (33 to 44 MB at up to 20x), which a real-time capture never builds; a per-buffer leak still grows here, stretch
    /// after stretch.
    func testMinutesOfBuffersKeepMemoryBounded() async throws {
        let (capture, url) = try newCapture()
        let footprints: [Double] = try await Task.detached {
            var t = 0.0
            var measured: [Double] = []
            for _ in 0..<10 {
                t = try Self.feed(capture, from: t, seconds: 30)
                Self.drain(url)
                measured.append(BroadcastCaptureWriter.footprintMB())
            }
            return measured
        }.value
        let trace = footprints.map { String(format: "%.1f", $0) }.joined(separator: " ")
        XCTAssertGreaterThan(footprints[0], 0, "phys_footprint unavailable")
        // From the first minute (stretch 2) to the last three stretches' median (minutes 4 to 5): a leak climbs
        // stretch after stretch (the 2.6 MB a minute once feared is ~8 MB here), while one sample caught before the
        // encoders finished (the device run 20261030-003046: 24.7 flat, then 28.4 on the last alone) doesn't move a
        // median.
        let lastThree = footprints.suffix(3).sorted()
        let growth = lastThree[1] - footprints[1]
        // AVAssetWriter itself grows in steps (its sample tables reallocating: about +4 MB once, around half an hour of
        // audio on macOS, the same with raw appends that skip this capture's conversion, one track or two, fragmented
        // or not) and creeps about 1.5 MB an hour: over a 4-hour capture, 7 to 13 MB on macOS. A step can land inside
        // this test (device run 20261030-003532: 25.2 to 30.9 MB); a leak in the conversion path at the rate once
        // feared (2.6 MB a minute) would be ~10 MB here. 6 MB tells them apart.
        XCTAssertLessThan(growth, 6, "footprint grew \(growth) MB over 4 minutes after warm-up, every 30 s: \(trace)")
        XCTAssertEqual(capture.writer.status, .writing, capture.diagnostic(stage: "test"))
        let completed = await withCheckedContinuation { done in capture.finish { done.resume(returning: $0) } }
        XCTAssertTrue(completed)
        let duration = try await AVURLAsset(url: url).load(.duration).seconds
        XCTAssertGreaterThan(duration, 295)
    }

    /// The system's finish arrives on its own thread while ReplayKit still delivers buffers on another: the finish
    /// completes, promptly, and appends after it are ignored, not failures.
    func testFinishCompletesWhileAppendsGoOnAnotherThread() async throws {
        let (capture, url) = try newCapture()
        _ = try Self.feed(capture, from: 0, seconds: 3)
        let appending = Task.detached {
            var t = 3.0
            for _ in 0..<400 {
                let mic = try RK.buffer(.mic48, frames: 1_024, startFrame: Int(t * 48_000), at: t)
                XCTAssertTrue(capture.append(mic, to: .mic))
                t += 1_024.0 / 48_000
            }
        }
        let started = Date()
        let completed: Bool = await withCheckedContinuation { done in
            DispatchQueue.global(qos: .userInitiated).async {
                capture.finish { done.resume(returning: $0) }
            }
        }
        let elapsed = Date().timeIntervalSince(started)
        try await appending.value
        XCTAssertTrue(completed, capture.diagnostic(stage: "finish"))
        XCTAssertLessThan(elapsed, 2.5, "the finish took \(elapsed) s; the extension waits 2.5 s at most")
        let tracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 2)
    }

    /// The finish called on the very thread that's appending (the cap, a failed append) completes too.
    func testFinishFromTheAppendingThreadCompletes() async throws {
        let (capture, _) = try newCapture()
        let completed: Bool = try await Task.detached {
            _ = try Self.feed(capture, from: 0, seconds: 2)
            return Self.finishWaiting(capture)
        }.value
        XCTAssertTrue(completed, capture.diagnostic(stage: "finish"))
    }

    /// As the extension does: finish, and wait for it at most as long as the extension does.
    nonisolated private static func finishWaiting(_ capture: BroadcastCaptureWriter) -> Bool {
        let done = DispatchSemaphore(value: 0)
        let result = ResultBox()
        capture.finish { result.value = $0; done.signal() }
        return done.wait(timeout: .now() + 2.5) == .success && result.value
    }

    private final class ResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored = false
        var value: Bool {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }

    /// `captureStats`, written at every heartbeat: app audio at a level, a microphone delivering digital silence
    /// (what a VoIP call may hand the extension) shows as -99 dBFS, with the formats and the footprint.
    func testStatsTellAudioFromSilence() throws {
        let (capture, _) = try newCapture()
        _ = try Self.feed(capture, from: 0, seconds: 2.5, micAmplitude: 0)
        let stats = capture.stats()
        XCTAssertLessThan(stats.utf8.count, 450, stats)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(stats.utf8)) as? [String: Any])
        let peaks = try XCTUnwrap(json["pk"] as? [Int], stats)
        XCTAssertTrue((-18 ... -3).contains(peaks[0]), stats) // a 0.25 tone, both channels mixed to one
        XCTAssertEqual(peaks[1], -99, stats)
        XCTAssertEqual(json["cur"] as? [String], ["44100/lpcm/0xe/2ch/4B", "48000/lpcm/0xc/1ch/2B"], stats)
        let received = try XCTUnwrap(json["rx"] as? [Int])
        XCTAssertGreaterThan(received[1], 0)
        XCTAssertGreaterThan((json["mb"] as? Int) ?? 0, 0, stats)
        capture.writer.cancelWriting()
    }

    // MARK: - A new broadcast never orphans an earlier capture

    private func killedCapture() async throws -> URL {
        let (capture, url) = try newCapture()
        _ = try Self.feed(capture, from: 0, seconds: 5)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let copy = dir.appendingPathComponent("broadcast_killed_\(UUID().uuidString).m4a")
        try FileManager.default.copyItem(at: url, to: copy)
        capture.writer.cancelWriting()
        return copy
    }

    /// The extension died mid-capture (state still "recording"), then a new broadcast starts: the dead one's file
    /// joins the unclaimed list, and the app claims it.
    func testACaptureLeftRecordingIsKeptWhenTheNextBroadcastStarts() async throws {
        let orphan = try await killedCapture()
        defaults.set("recording", forKey: "state")
        defaults.set(true, forKey: "isBroadcasting")
        defaults.set(orphan.path, forKey: "activeBroadcastFile")
        let next = dir.appendingPathComponent("broadcast_next.m4a").path
        let kept = BroadcastStartRecord.begin(path: next, defaults: defaults, now: Date().timeIntervalSince1970)
        XCTAssertEqual(kept, [orphan.path])
        XCTAssertEqual(defaults.stringArray(forKey: BroadcastHandoff.unclaimedKey), [orphan.path])
        XCTAssertEqual(defaults.string(forKey: "activeBroadcastFile"), next)
        XCTAssertEqual(defaults.string(forKey: "state"), "starting")

        let handoff = BroadcastHandoff(store: RecordingStore(directory: dir.appendingPathComponent("recordings")), defaults: defaults)
        XCTAssertTrue(handoff.hasFinishedCapture)
        let result = await handoff.claim()
        guard case .ready(_, let seconds) = result else { return XCTFail("the orphan wasn't claimed: \(result)") }
        XCTAssertGreaterThan(seconds, 0)
    }

    func testAFinishedUnclaimedCaptureIsKeptWhenTheNextBroadcastStarts() {
        defaults.set("finished", forKey: "state")
        defaults.set("/captures/broadcast_done.m4a", forKey: "completedBroadcastFile")
        let kept = BroadcastStartRecord.begin(path: "/captures/broadcast_new.m4a", defaults: defaults, now: 1, fileExists: { _ in true })
        XCTAssertEqual(kept, ["/captures/broadcast_done.m4a"])
        XCTAssertNil(defaults.string(forKey: "completedBroadcastFile"))
    }

    func testNothingIsKeptWhenThereIsNothingToKeep() {
        // A dead capture whose file is gone, and one already claimed: nothing to keep.
        defaults.set("recording", forKey: "state")
        defaults.set("/captures/broadcast_gone.m4a", forKey: "activeBroadcastFile")
        XCTAssertEqual(BroadcastStartRecord.begin(path: "/captures/a.m4a", defaults: defaults, now: 1, fileExists: { _ in false }), [])
        defaults.set("claimed", forKey: "state")
        defaults.set("/captures/broadcast_old.m4a", forKey: "activeBroadcastFile")
        XCTAssertEqual(BroadcastStartRecord.begin(path: "/captures/b.m4a", defaults: defaults, now: 1, fileExists: { _ in true }), [])
        XCTAssertNil(defaults.stringArray(forKey: BroadcastHandoff.unclaimedKey))
    }
}
