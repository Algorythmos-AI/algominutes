import AVFoundation
import XCTest
@testable import AlgoMinutes

/// A finished broadcast capture is claimed once, with its app-audio and
/// microphone tracks mixed into the one track the transcoder hears.
@MainActor
final class BroadcastHandoffTests: XCTestCase {
    private var dir: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("bcast-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "test.broadcast.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func handoff(now: Date = Date()) -> BroadcastHandoff {
        BroadcastHandoff(store: RecordingStore(directory: dir.appendingPathComponent("recordings")), defaults: defaults, now: { now })
    }

    /// A tone on `on` (seconds), silence elsewhere, as one-track AAC .m4a.
    private func tone(_ name: String, on: ClosedRange<Double>, total: Double) throws -> URL {
        let url = dir.appendingPathComponent(name)
        let f = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let n = AVAudioFrameCount(44_100 * total)
        let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: n)!
        b.frameLength = n
        for i in 0..<Int(n) {
            let t = Double(i) / 44_100
            b.floatChannelData![0][i] = on.contains(t) ? Float(sin(2 * .pi * 440 * t)) * 0.3 : 0
        }
        try f.write(from: b)
        return url
    }

    /// What the extension leaves: one .m4a, app audio and microphone on two tracks.
    private func twoTrackCapture() async throws -> URL {
        let app = try tone("app.m4a", on: 0...2, total: 4)
        let mic = try tone("mic.m4a", on: 2...4, total: 4)
        let comp = AVMutableComposition()
        for src in [app, mic] {
            let asset = AVURLAsset(url: src)
            let track = try await asset.loadTracks(withMediaType: .audio)[0]
            let t = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
            try t.insertTimeRange(CMTimeRange(start: .zero, duration: try await asset.load(.duration)), of: track, at: .zero)
        }
        let out = dir.appendingPathComponent("broadcast_capture.m4a")
        let e = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough)!
        e.outputURL = out
        e.outputFileType = .m4a
        await e.export()
        XCTAssertEqual(e.status, .completed)
        let tracks = try await AVURLAsset(url: out).loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 2)
        return out
    }

    private func rmsHalves(_ url: URL) throws -> (Float, Float) {
        let f = try AVAudioFile(forReading: url)
        let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length))!
        try f.read(into: b)
        let n = Int(b.frameLength), h = n / 2, d = b.floatChannelData![0]
        func r(_ a: Int, _ z: Int) -> Float { var s: Float = 0; for i in a..<z { s += d[i] * d[i] }; return (s / Float(z - a)).squareRoot() }
        return (r(0, h), r(h, n))
    }

    func testAFinishedCaptureIsMixedToOneTrackAndClaimedOnce() async throws {
        let capture = try await twoTrackCapture()
        defaults.set("finished", forKey: "state")
        defaults.set(capture.path, forKey: "completedBroadcastFile")

        let h = handoff()
        guard case .ready(let file, let seconds) = await h.claim() else { return XCTFail("not ready") }
        XCTAssertEqual(seconds, 4)
        let mixedTracks = try await AVURLAsset(url: file).loadTracks(withMediaType: .audio)
        XCTAssertEqual(mixedTracks.count, 1)
        let (first, second) = try rmsHalves(file)
        XCTAssertGreaterThan(first, 0.05, "app audio missing from the mix")
        XCTAssertGreaterThan(second, 0.05, "microphone missing from the mix")
        XCTAssertFalse(FileManager.default.fileExists(atPath: capture.path), "the App Group copy is removed")
        let again = await h.claim()
        XCTAssertEqual(again, .none)
    }

    func testAnExtensionErrorIsReportedOnce() async {
        defaults.set("error", forKey: "state")
        defaults.set("Broadcast ended without recording any audio", forKey: "errorMessage")
        let first = await handoff().claim()
        XCTAssertEqual(first, .failed(message: "Broadcast ended without recording any audio"))
        let second = await handoff().claim()
        XCTAssertEqual(second, .none)
    }

    func testAnExtensionThatDiedMidCaptureIsReportedAndItsPartialFileRemoved() async throws {
        let partial = dir.appendingPathComponent("broadcast_partial.m4a")
        try Data(repeating: 0, count: 64).write(to: partial)
        let now = Date()
        defaults.set("recording", forKey: "state")
        defaults.set(true, forKey: "isBroadcasting")
        defaults.set(partial.path, forKey: "activeBroadcastFile")
        defaults.set(now.timeIntervalSince1970 - 120, forKey: "lastHeartbeatAt")
        let h = handoff(now: now)
        XCTAssertFalse(h.isCapturing)
        guard case .failed = await h.claim() else { return XCTFail("expected failed") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    }

    func testALiveCaptureIsLeftAlone() async {
        let now = Date()
        defaults.set("recording", forKey: "state")
        defaults.set(true, forKey: "isBroadcasting")
        defaults.set(now.timeIntervalSince1970 - 5, forKey: "lastHeartbeatAt")
        let h = handoff(now: now)
        XCTAssertTrue(h.isCapturing)
        let result = await h.claim()
        XCTAssertEqual(result, .none)
    }
}
