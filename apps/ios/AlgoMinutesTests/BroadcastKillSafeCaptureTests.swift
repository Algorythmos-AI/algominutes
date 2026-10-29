import AVFoundation
import XCTest
@testable import AlgoMinutes

/// I3 (N4): iOS can kill the broadcast extension mid-call (its ~50 MB memory limit, a hard stop, a crash), and
/// `finishWriting` never runs. What the extension's writer (BroadcastShared/BroadcastCaptureWriter, compiled
/// into this bundle) put on disk until then must still be a readable capture, and the app must make it a note.
@MainActor
final class BroadcastKillSafeCaptureTests: XCTestCase {
    private var dir: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("bkill-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "test.broadcast.kill.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func handoff(now: Date) -> BroadcastHandoff {
        BroadcastHandoff(store: RecordingStore(directory: dir.appendingPathComponent("recordings")), defaults: defaults, now: { now })
    }

    struct SampleError: Error { let what: String }

    /// `frames` of a 440 Hz tone as 16-bit mono PCM at `rate`, starting at `startFrame`: what ReplayKit hands
    /// the extension, in shape.
    private static func tone(startFrame: Int, frames: Int, rate: Int) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
        )
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                             magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr,
              let format else { throw SampleError(what: "format") }
        // Split into typed steps: one expression was too much for CI's type checker.
        let step: Double = 2 * Double.pi * 440 / Double(rate)
        let samples: [Int16] = (0..<frames).map { (i: Int) -> Int16 in
            let phase: Double = step * Double(startFrame + i)
            return Int16(sin(phase) * 8_000)
        }
        let length = frames * 2
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length, blockAllocator: nil,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: length,
                                                 flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block else { throw SampleError(what: "block") }
        let copied = samples.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
        }
        guard copied == noErr else { throw SampleError(what: "copy") }
        var buffer: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
            presentationTimeStamp: CMTime(value: CMTimeValue(startFrame), timescale: CMTimeScale(rate)),
            packetDescriptions: nil, sampleBufferOut: &buffer
        ) == noErr, let buffer else { throw SampleError(what: "sample buffer") }
        return buffer
    }

    /// `seconds` of audio on both tracks through the extension's own writer, then the process "dies": no
    /// markAsFinished, no finishWriting. Returns a copy of the file's bytes as they are on disk at that moment.
    private func killedCapture(seconds: Double) async throws -> URL {
        let url = dir.appendingPathComponent("broadcast_\(UUID().uuidString).m4a")
        let capture = try BroadcastCaptureWriter.make(url: url)
        XCTAssertTrue(capture.writer.startWriting(), "startWriting: \(String(describing: capture.writer.error))")
        capture.writer.startSession(atSourceTime: .zero)
        let rate = 48_000, chunk = 1_024, total = Int(Double(rate) * seconds)
        var frame = 0
        while frame < total {
            for input in [capture.appInput, capture.micInput] {
                var waits = 0
                while !input.isReadyForMoreMediaData, waits < 1_000 {
                    try await Task.sleep(nanoseconds: 2_000_000)
                    waits += 1
                }
                guard input.append(try Self.tone(startFrame: frame, frames: chunk, rate: rate)) else {
                    throw SampleError(what: "append failed: status \(capture.writer.status.rawValue), \(String(describing: capture.writer.error))")
                }
            }
            frame += chunk
        }
        // The call goes on for a moment (the writer's own queue puts what it has encoded on disk), then the
        // extension is killed: the bytes on disk are all there is.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(capture.writer.status, .writing)
        let killed = dir.appendingPathComponent("killed_\(UUID().uuidString).m4a")
        try FileManager.default.copyItem(at: url, to: killed)
        capture.writer.cancelWriting()
        return killed
    }

    func testACaptureKilledBeforeFinishWritingIsStillReadable() async throws {
        let killed = try await killedCapture(seconds: 6)
        let size = (try FileManager.default.attributesOfItem(atPath: killed.path)[.size] as? Int) ?? 0
        XCTAssertGreaterThan(size, 0, "the writer put nothing on disk")
        let asset = AVURLAsset(url: killed)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            return XCTFail("the killed capture (\(size) bytes) can't be opened: \(error.localizedDescription)")
        }
        XCTAssertEqual(tracks.count, 2, "the killed capture (\(size) bytes) has \(tracks.count) audio tracks, not app + microphone")
        for track in tracks {
            let playable = try await track.load(.isPlayable)
            XCTAssertTrue(playable, "an audio track of the killed capture isn't playable")
        }
        let duration = try await asset.load(.duration).seconds
        // Everything up to the last fragment written before the kill.
        XCTAssertGreaterThanOrEqual(duration, 2, "the killed capture (\(size) bytes) plays for \(duration) s of the 6 s captured")
        // And the app's own mix-down (BroadcastHandoff) reads it, as it does a finished capture.
        let seconds = try await BroadcastHandoff.mixDown(source: killed, destination: dir.appendingPathComponent("mixed.m4a"))
        XCTAssertGreaterThan(seconds, 0)
    }

    /// The app finds the extension dead (no heartbeat): the capture it left is made a note, after the same
    /// switch and consent as a finished one, instead of being deleted.
    func testACaptureWhoseExtensionWasKilledIsClaimedNotDeleted() async throws {
        let killed = try await killedCapture(seconds: 6)
        let now = Date()
        defaults.set("recording", forKey: "state")
        defaults.set(true, forKey: "isBroadcasting")
        defaults.set(killed.path, forKey: "activeBroadcastFile")
        defaults.set(now.timeIntervalSince1970 - 120, forKey: "lastHeartbeatAt")
        let h = handoff(now: now)
        XCTAssertFalse(h.isCapturing)
        XCTAssertTrue(h.hasFinishedCapture, "a killed capture must wait for the switch and consent like a finished one")
        let result = await h.claim()
        guard case .ready(let url, let seconds) = result else {
            return XCTFail("the killed capture wasn't claimed: \(result)")
        }
        XCTAssertGreaterThan(seconds, 0)
        let mixed = try await AVURLAsset(url: url).loadTracks(withMediaType: .audio)
        XCTAssertEqual(mixed.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: killed.path))
        XCTAssertFalse(h.hasFinishedCapture)
        let again = await h.claim()
        XCTAssertEqual(again, .none)
    }

    func testDecliningAKilledCaptureDiscardsIt() async throws {
        let killed = dir.appendingPathComponent("broadcast_partial.m4a")
        try Data(repeating: 0, count: 64).write(to: killed)
        let now = Date()
        defaults.set("recording", forKey: "state")
        defaults.set(true, forKey: "isBroadcasting")
        defaults.set(killed.path, forKey: "activeBroadcastFile")
        defaults.set(now.timeIntervalSince1970 - 120, forKey: "lastHeartbeatAt")
        let h = handoff(now: now)
        XCTAssertTrue(h.hasFinishedCapture)
        h.discardFinished()
        XCTAssertFalse(FileManager.default.fileExists(atPath: killed.path))
        XCTAssertFalse(h.hasFinishedCapture)
        let result = await h.claim()
        XCTAssertEqual(result, .none)
    }
}
