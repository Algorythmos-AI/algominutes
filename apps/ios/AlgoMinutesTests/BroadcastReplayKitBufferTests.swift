import AVFoundation
import XCTest
@testable import AlgoMinutes

/// 2026-10-29, iPhone 11 Pro Max: every real broadcast (during a WhatsApp call, and with no call at all) failed on
/// its first appends, while BroadcastKillSafeCaptureTests passed on the same phone with synthetic 48 kHz mono
/// little-endian buffers starting at time zero. These feed the extension's capture
/// (BroadcastShared/BroadcastCaptureWriter, compiled into this bundle) what ReplayKit hands it instead: app audio as
/// 16-bit big-endian interleaved stereo, the microphone as 16-bit or Float32 mono, host-clock timestamps, a format
/// that changes mid-stream, a stream that starts earlier than the session, and a call where app audio never comes.
/// Each must keep the writer writing, leave a file readable before `finishWriting` (the kill case) and play with both
/// tracks after it.
@MainActor
final class BroadcastReplayKitBufferTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("brk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    struct SampleError: Error { let what: String }

    /// A source format as ReplayKit describes it.
    struct Shape {
        var rate: Double
        var channels: UInt32
        var float = false
        var bigEndian = false
        var nonInterleaved = false

        /// `.audioApp`, commonly: 44.1 kHz stereo, 16-bit signed, big-endian, interleaved (flags 0xE).
        static let appBigEndian44 = Shape(rate: 44_100, channels: 2, bigEndian: true)
        static let appBigEndian48 = Shape(rate: 48_000, channels: 2, bigEndian: true)
        /// `.audioMic`: mono 16-bit little-endian (flags 0xC) at 48 or 44.1 kHz, or Float32.
        static let mic48 = Shape(rate: 48_000, channels: 1)
        static let mic44 = Shape(rate: 44_100, channels: 1)
        static let micFloat48 = Shape(rate: 48_000, channels: 1, float: true)
        /// What a voice-processing route can switch the microphone to mid-call.
        static let micFloat16 = Shape(rate: 16_000, channels: 1, float: true)
        static let appFloatPlanar48 = Shape(rate: 48_000, channels: 2, float: true, nonInterleaved: true)
    }

    /// A host-clock time base, as ReplayKit's timestamps are (seconds since boot, nanosecond timescale).
    private static let hostBase = 345_678.912_345

    /// `frames` of a 440 Hz tone in `shape`, at host time `hostBase + seconds`.
    static func buffer(_ shape: Shape, frames: Int, startFrame: Int, at seconds: Double) throws -> CMSampleBuffer {
        let sampleBytes: UInt32 = shape.float ? 4 : 2
        var flags: AudioFormatFlags = kAudioFormatFlagIsPacked
        flags |= shape.float ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger
        if shape.bigEndian { flags |= kAudioFormatFlagIsBigEndian }
        if shape.nonInterleaved { flags |= kAudioFormatFlagIsNonInterleaved }
        let frameBytes = shape.nonInterleaved ? sampleBytes : sampleBytes * shape.channels
        var asbd = AudioStreamBasicDescription(
            mSampleRate: shape.rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags, mBytesPerPacket: frameBytes,
            mFramesPerPacket: 1, mBytesPerFrame: frameBytes, mChannelsPerFrame: shape.channels,
            mBitsPerChannel: sampleBytes * 8, mReserved: 0
        )
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                             magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr,
              let format else { throw SampleError(what: "format") }
        let channels = Int(shape.channels)
        let length = frames * Int(sampleBytes) * channels
        var bytes = [UInt8](repeating: 0, count: length)
        let step: Double = 2 * Double.pi * 440 / shape.rate
        for i in 0..<frames {
            let value: Double = sin(step * Double(startFrame + i)) * 0.25
            for c in 0..<channels {
                let index = shape.nonInterleaved ? c * frames + i : i * channels + c
                if shape.float {
                    let bits = shape.bigEndian ? Float(value).bitPattern.bigEndian : Float(value).bitPattern.littleEndian
                    withUnsafeBytes(of: bits) { raw in for b in 0..<4 { bytes[index * 4 + b] = raw[b] } }
                } else {
                    let sample = Int16(value * 32_767)
                    let ordered = shape.bigEndian ? sample.bigEndian : sample.littleEndian
                    withUnsafeBytes(of: ordered) { raw in for b in 0..<2 { bytes[index * 2 + b] = raw[b] } }
                }
            }
        }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length, blockAllocator: nil,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: length,
                                                 flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block else { throw SampleError(what: "block") }
        let copied = bytes.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
        }
        guard copied == noErr else { throw SampleError(what: "copy") }
        var buffer: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
            presentationTimeStamp: CMTime(seconds: hostBase + seconds, preferredTimescale: 1_000_000_000),
            packetDescriptions: nil, sampleBufferOut: &buffer
        ) == noErr, let buffer else { throw SampleError(what: "sample buffer") }
        return buffer
    }

    /// One source: its format (and the one it switches to at `changeAt`), its buffer size, when it starts.
    struct Source {
        var shape: Shape
        var frames = 1_024
        var start: Double = 0
        var changeAt: Double?
        var changeTo: Shape?
    }

    /// Feeds `app` and `mic` (nil: that stream never comes) for `seconds`, in timestamp order as ReplayKit would,
    /// through the capture's own append. Every append must succeed.
    private func feed(_ capture: BroadcastCaptureWriter, app: Source?, mic: Source?, seconds: Double) async throws {
        var events: [(time: Double, track: BroadcastCaptureWriter.Track, shape: Shape, frames: Int, startFrame: Int)] = []
        for (source, track) in [(app, BroadcastCaptureWriter.Track.app), (mic, .mic)] {
            guard let source else { continue }
            var time = source.start
            var frame = 0
            while time < seconds {
                let changed = source.changeAt.map { time >= $0 } ?? false
                let shape = changed ? (source.changeTo ?? source.shape) : source.shape
                events.append((time, track, shape, source.frames, frame))
                frame += source.frames
                time += Double(source.frames) / shape.rate
            }
        }
        events.sort { $0.time < $1.time }
        for event in events {
            let input = event.track == .app ? capture.appInput : capture.micInput
            var waits = 0
            while !input.isReadyForMoreMediaData, waits < 500 {
                try await Task.sleep(nanoseconds: 2_000_000)
                waits += 1
            }
            let buffer = try Self.buffer(event.shape, frames: event.frames, startFrame: event.startFrame, at: event.time)
            guard capture.append(buffer, to: event.track) else {
                throw SampleError(what: "append failed at \(event.time) s: \(capture.diagnostic(stage: "test"))")
            }
        }
        XCTAssertEqual(capture.writer.status, .writing, capture.diagnostic(stage: "test"))
    }

    /// The bytes on disk now, as an extension killed at this moment would leave them.
    private func killedCopy(of url: URL) async throws -> URL {
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let copy = dir.appendingPathComponent("killed_\(UUID().uuidString).m4a")
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    }

    private func assertReadable(_ url: URL, atLeast seconds: Double, _ what: String,
                                file: StaticString = #filePath, line: UInt = #line) async throws {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            return XCTFail("\(what) can't be opened: \(error.localizedDescription)", file: file, line: line)
        }
        XCTAssertEqual(tracks.count, 2, "\(what) has \(tracks.count) audio tracks, not app + microphone", file: file, line: line)
        for track in tracks {
            let playable = try await track.load(.isPlayable)
            XCTAssertTrue(playable, "\(what): a track isn't playable", file: file, line: line)
        }
        let duration = try await asset.load(.duration).seconds
        XCTAssertGreaterThanOrEqual(duration, seconds, "\(what) plays for \(duration) s", file: file, line: line)
    }

    /// A capture of `seconds` from these sources: readable before the finish, and after it complete, both tracks
    /// about `seconds` long, and the app's mix-down reads it.
    private func capture(app: Source?, mic: Source?, seconds: Double) async throws -> BroadcastCaptureWriter {
        let url = dir.appendingPathComponent("broadcast_\(UUID().uuidString).m4a")
        let capture = try BroadcastCaptureWriter.make(url: url)
        XCTAssertTrue(capture.start(), capture.diagnostic(stage: "start"))
        try await feed(capture, app: app, mic: mic, seconds: seconds)

        // The kill case: everything up to the last fragment, both tracks, before finishWriting.
        try await assertReadable(try await killedCopy(of: url), atLeast: seconds - 4, "the capture before finishWriting")

        let completed = await withCheckedContinuation { done in capture.finish { done.resume(returning: $0) } }
        XCTAssertTrue(completed, capture.diagnostic(stage: "finish"))
        try await assertReadable(url, atLeast: seconds - 0.5, "the finished capture")
        let total = try await AVURLAsset(url: url).load(.duration).seconds
        XCTAssertLessThanOrEqual(total, seconds + 0.5, "the finished capture is \(total) s of \(seconds) s fed")
        let mixed = try await BroadcastHandoff.mixDown(source: url, destination: dir.appendingPathComponent("mixed_\(UUID().uuidString).m4a"))
        XCTAssertGreaterThanOrEqual(Double(mixed), seconds - 1)
        return capture
    }

    func testReplayKitsAppAndMicrophoneFormatsAreWritten() async throws {
        let capture = try await capture(app: Source(shape: .appBigEndian44, start: 0.02), mic: Source(shape: .mic48), seconds: 7)
        XCTAssertGreaterThan(capture.appendedBuffers(.app), 0)
        XCTAssertGreaterThan(capture.appendedBuffers(.mic), 0)
    }

    func testOtherSourceFormatsAreWritten() async throws {
        _ = try await capture(app: Source(shape: .appBigEndian48), mic: Source(shape: .micFloat48, frames: 960), seconds: 5)
        _ = try await capture(app: Source(shape: .appFloatPlanar48), mic: Source(shape: .mic44), seconds: 5)
    }

    /// A call starting re-routes the microphone (voice processing) and can change the app audio's format.
    func testAFormatChangeMidStreamIsWritten() async throws {
        let capture = try await capture(
            app: Source(shape: .appBigEndian44, changeAt: 2.5, changeTo: .appBigEndian48),
            mic: Source(shape: .mic48, changeAt: 3, changeTo: .micFloat16),
            seconds: 7
        )
        let diagnostic = capture.diagnostic(stage: "test")
        XCTAssertTrue(diagnostic.contains("\"chg\":[true,true]"), diagnostic)
    }

    /// A call app's own audio isn't captured: `.audioApp` delivers nothing. The microphone alone must still make a
    /// file that's readable before finishWriting (a fragment needs both tracks: the app track is filled with
    /// silence) and that plays for the whole call after it.
    func testACallWithNoAppAudioIsStillKillSafe() async throws {
        let capture = try await capture(app: nil, mic: Source(shape: .mic48), seconds: 7)
        XCTAssertEqual(capture.appendedBuffers(.app), 0)
    }

    /// App audio that starts seconds into the capture keeps its place on the timeline.
    func testAppAudioStartingLateKeepsItsPlace() async throws {
        _ = try await capture(app: Source(shape: .appBigEndian44, start: 3), mic: Source(shape: .mic48), seconds: 7)
    }

    /// The session starts at the first buffer of either type; the other's earlier buffers are trimmed, not a failure.
    func testAStreamStartingBeforeTheSessionIsTrimmed() async throws {
        let url = dir.appendingPathComponent("broadcast_\(UUID().uuidString).m4a")
        let capture = try BroadcastCaptureWriter.make(url: url)
        XCTAssertTrue(capture.start())
        XCTAssertTrue(capture.append(try Self.buffer(.appBigEndian44, frames: 1_024, startFrame: 0, at: 0.5), to: .app))
        XCTAssertTrue(capture.append(try Self.buffer(.mic48, frames: 1_024, startFrame: 0, at: 0.2), to: .mic))
        try await feed(capture, app: Source(shape: .appBigEndian44, start: 0.6), mic: Source(shape: .mic48, start: 0.3), seconds: 4)
        let completed = await withCheckedContinuation { done in capture.finish { done.resume(returning: $0) } }
        XCTAssertTrue(completed, capture.diagnostic(stage: "finish"))
        try await assertReadable(url, atLeast: 3, "the finished capture")
    }

    /// What the extension stores as `lastWriterError`: compact JSON, formats and counts, no paths or ids.
    func testTheDiagnosticIsCompactAndNamesTheSourceFormats() async throws {
        let url = dir.appendingPathComponent("broadcast_\(UUID().uuidString).m4a")
        let capture = try BroadcastCaptureWriter.make(url: url)
        XCTAssertTrue(capture.start())
        try await feed(capture, app: Source(shape: .appBigEndian44), mic: Source(shape: .mic48), seconds: 1)
        let diagnostic = capture.diagnostic(stage: "append")
        XCTAssertLessThan(diagnostic.utf8.count, 500, diagnostic)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(diagnostic.utf8)) as? [String: Any])
        XCTAssertEqual(json["at"] as? String, "append")
        XCTAssertEqual(json["status"] as? Int, AVAssetWriter.Status.writing.rawValue)
        XCTAssertEqual(json["fmt"] as? [String], ["44100/lpcm/0xe/2ch/4B", "48000/lpcm/0xc/1ch/2B"])
        XCTAssertFalse(diagnostic.contains(dir.path), "the diagnostic must not carry paths")
        capture.writer.cancelWriting()
    }
}
