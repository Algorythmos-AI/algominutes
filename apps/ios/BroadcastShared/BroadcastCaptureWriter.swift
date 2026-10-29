import AVFoundation
import AudioToolbox

/// The writer the broadcast extension captures into (BroadcastExtension/SampleHandler): one fragmented AAC `.m4a`,
/// app audio and microphone on two tracks. Compiled into the extension and the unit tests (project.yml), so the
/// tests exercise the code that ships.
///
/// ReplayKit hands the extension whatever its sources produce: app audio is often 44.1 kHz stereo big-endian
/// integers, the microphone 48 kHz mono, and during a VoIP call either can be another rate, float, non-interleaved,
/// change format mid-stream, or (app audio, for a call app) never come at all. None of that reaches the AAC
/// encoders: every buffer is converted here to ONE fixed format per track (`trackFormat`) and placed on the track's
/// own contiguous timeline, and a track that falls behind the other is filled with silence, so both tracks always
/// advance together and the fragmented file is readable up to its last fragment if the extension is killed.
///
/// Not thread-safe by itself for the writer's own sake: every entry point takes `lock`, so ReplayKit's sample
/// callback and the system's finish can't interleave.
final class BroadcastCaptureWriter {
    enum Track: Int, CaseIterable {
        case app = 0, mic = 1
        var name: String { self == .app ? "app" : "mic" }
    }

    let writer: AVAssetWriter
    /// The other app's audio (`.audioApp`).
    let appInput: AVAssetWriterInput
    /// The microphone (`.audioMic`).
    let micInput: AVAssetWriterInput

    /// The rate both tracks are kept at, and encoded at.
    static let sampleRate = 44_100

    /// AAC, 44.1 kHz, mono, 64 kbps. The inputs only ever see `trackFormat`, so the encoders never convert.
    static let audioSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64_000,
    ]

    /// What every buffer is converted to before it reaches an input: 16-bit signed little-endian mono PCM at 44.1 kHz,
    /// interleaved and packed (the shape #532's on-device test proved the writer takes).
    static let trackFormat = AudioStreamBasicDescription(
        mSampleRate: Float64(sampleRate), mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
    )

    /// How often the writer puts a movie fragment on disk (I3, N4). A plain `.m4a` gets its index (the moov
    /// atom) only from `finishWriting`, so an extension iOS killed mid-call (its ~50 MB memory limit, a hard
    /// stop, a crash) left a file nothing could open: the whole call lost. A fragmented file is readable up to
    /// its last fragment without `finishWriting`. A fragment needs both tracks to reach it, hence `fillLag`.
    static let fragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

    /// How far a track may fall behind the other before it's filled with silence. Audio arriving later than this
    /// (relative to the other track) loses the part that overlaps the silence. A kill costs at most about
    /// `fragmentInterval` + `fillLag`.
    static let fillLag = 1.0
    /// Timestamp jitter absorbed without padding or trimming.
    static let tolerance = 0.05
    /// A gap on both tracks longer than this (a paused broadcast) is skipped, not filled with silence.
    static let maxFill = 10.0

    enum SetupError: Error { case cannotAddInput }

    /// A writer at `url`, not started. Two separate audio tracks: each input keeps its own monotonic timeline.
    static func make(url: URL) throws -> BroadcastCaptureWriter {
        let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        writer.movieFragmentInterval = fragmentInterval
        writer.initialMovieFragmentInterval = fragmentInterval
        func input() throws -> AVAssetWriterInput {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw SetupError.cannotAddInput }
            writer.add(input)
            return input
        }
        return BroadcastCaptureWriter(writer: writer, appInput: try input(), micInput: try input())
    }

    private init(writer: AVAssetWriter, appInput: AVAssetWriterInput, micInput: AVAssetWriterInput) {
        self.writer = writer
        self.appInput = appInput
        self.micInput = micInput
    }

    deinit { CMMemoryPoolInvalidate(blocks) }

    // MARK: - State (guarded by `lock`)

    private let lock = NSLock()
    private var sessionStart: CMTime?
    /// Frames each track holds, from the session start: where its next frame goes.
    private var written: [Int64] = [0, 0]
    /// Per track, frames taken out of its timeline: a jump in its timestamps longer than `maxFill` (a paused
    /// broadcast, a source whose clock restarted). The output timeline stays contiguous.
    private var skipped: [Int64] = [0, 0]
    private var finished = false
    private let normalizers = [PCMNormalizer(), PCMNormalizer()]
    private let blocks = CMMemoryPoolCreate(options: nil)
    private var outputFormat: CMAudioFormatDescription?

    /// Counts and formats for `diagnostic(stage:)`: never audio or ids.
    private let diagnostics = BroadcastWriterDiagnostics()
    private var failedTrack: Track?

    var sessionStarted: Bool { lock.withLock { sessionStart != nil } }
    /// Buffers dropped because an input wasn't ready, or couldn't be converted.
    var droppedBuffers: Int { lock.withLock { diagnostics.droppedTotal } }
    /// Real (not silence) buffers appended to a track.
    func appendedBuffers(_ track: Track) -> Int { lock.withLock { diagnostics.appendedCount(track.rawValue) } }
    private var conversionFailed = false
    private var conversionReported = false
    /// True once, the first time a buffer couldn't be converted: the caller records the diagnostic then.
    func takeConversionFailure() -> Bool {
        lock.withLock {
            guard conversionFailed, !conversionReported else { return false }
            conversionReported = true
            return true
        }
    }

    /// `startWriting`. False if the writer can't start; `diagnostic(stage:)` says why.
    func start() -> Bool { writer.startWriting() }

    /// Converts `sampleBuffer` and appends it to `track`, starting the session at the first buffer of either track.
    /// False only when the writer has failed and nothing more can be written; a buffer that can't be converted or
    /// that an input wasn't ready for is counted and dropped, the capture goes on.
    func append(_ sampleBuffer: CMSampleBuffer, to track: Track) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !finished else { return true }
        guard writer.status == .writing else { return false }
        let i = track.rawValue
        diagnostics.saw(sampleBuffer, on: i)

        if sessionStart == nil {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard pts.isNumeric else { diagnostics.dropped(on: i); return true }
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
        }
        guard let frames = normalizers[i].convert(sampleBuffer) else {
            diagnostics.unconvertible(on: i, status: normalizers[i].lastStatus)
            conversionFailed = true
            return true
        }
        guard frames > 0 else { return true }
        return place(track, frames: frames, at: position(of: sampleBuffer, track: i))
    }

    /// Fills the shorter track with silence to the longer one's end, marks both inputs finished and finishes the
    /// file. `completion` gets whether the file was completed.
    func finish(completion: @escaping (Bool) -> Void) {
        lock.lock()
        guard !finished, sessionStart != nil, writer.status == .writing else {
            finished = true
            lock.unlock()
            completion(writer.status == .completed)
            return
        }
        let end = written.max() ?? 0
        for track in Track.allCases { _ = fill(track, to: end) }
        finished = true
        appInput.markAsFinished()
        micInput.markAsFinished()
        lock.unlock()
        writer.finishWriting { [writer] in completion(writer.status == .completed) }
    }

    // MARK: - Timeline

    /// Where `sampleBuffer` starts on the tracks' timeline, in frames from the session start.
    private func position(of sampleBuffer: CMSampleBuffer, track i: Int) -> Int64 {
        guard let start = sessionStart else { return 0 }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isNumeric else { return written[i] }
        let delta = CMTimeConvertScale(CMTimeSubtract(pts, start), timescale: CMTimeScale(Self.sampleRate),
                                       method: .roundHalfAwayFromZero)
        return delta.value - skipped[i]
    }

    private static func frames(_ seconds: Double) -> Int64 { Int64(seconds * Double(sampleRate)) }

    /// Puts the `frames` converted frames of `track` at `start`: a gap before them is filled with silence (or, a
    /// pause, skipped), frames that overlap what the track already holds are dropped, jitter is ignored. Then the
    /// other track is filled up to `fillLag` behind this one.
    private func place(_ track: Track, frames: Int, at start: Int64) -> Bool {
        let i = track.rawValue
        var start = start
        if start - written[i] > Self.frames(Self.maxFill) {
            // A jump this long isn't a gap to fill with silence (a pause, a restarted clock): the track carries on
            // from where it is. A track that only went quiet doesn't get here: it's filled as the other advances.
            let cut = start - written[i]
            skipped[i] += cut
            start -= cut
        }
        var offset = 0
        var count = frames
        let gap = start - written[i]
        if gap > Self.frames(Self.tolerance) {
            guard fill(track, to: start) else { return false }
        } else if gap < -Self.frames(Self.tolerance) {
            // Already on the track (silence that filled for it, or a timestamp that went back): dropped.
            let overlap = Int(min(Int64(count), -gap))
            offset = overlap
            count -= overlap
        }
        if count > 0 {
            let bytes = normalizers[i].output.advanced(by: offset * Int(Self.trackFormat.mBytesPerFrame))
            guard appendFrames(track, bytes: UnsafeRawPointer(bytes), count: count, real: true) else { return false }
        }
        let other: Track = track == .app ? .mic : .app
        let target = written[i] - Self.frames(Self.fillLag)
        if written[other.rawValue] < target {
            return fill(other, to: target)
        }
        return true
    }

    /// Silence on `track` up to frame `end`. False only if the writer failed.
    private func fill(_ track: Track, to end: Int64) -> Bool {
        let i = track.rawValue
        while written[i] < end {
            let count = Int(min(Int64(Silence.frames), end - written[i]))
            let before = written[i]
            guard appendFrames(track, bytes: nil, count: count, real: false) else { return false }
            if written[i] == before { break } // the input isn't ready: caught up on a later buffer
        }
        return true
    }

    /// One sample buffer of `count` frames of `trackFormat` (silence when `bytes` is nil) at the track's end.
    /// False only if the writer failed; an input that isn't ready drops it (the gap is filled later).
    private func appendFrames(_ track: Track, bytes: UnsafeRawPointer?, count: Int, real: Bool) -> Bool {
        let i = track.rawValue
        let input = track == .app ? appInput : micInput
        guard input.isReadyForMoreMediaData else {
            if real { diagnostics.dropped(on: i) }
            return true
        }
        guard let buffer = makeBuffer(bytes: bytes, count: count, at: written[i]) else {
            if real { diagnostics.dropped(on: i) }
            return true
        }
        guard input.append(buffer) else {
            failedTrack = track
            return false
        }
        written[i] += Int64(count)
        if real { diagnostics.appended(on: i) } else { diagnostics.filled(count, on: i) }
        return true
    }

    private func makeBuffer(bytes: UnsafeRawPointer?, count: Int, at frame: Int64) -> CMSampleBuffer? {
        guard let start = sessionStart else { return nil }
        if outputFormat == nil {
            var asbd = Self.trackFormat
            let status = CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                                        magicCookie: nil, extensions: nil, formatDescriptionOut: &outputFormat)
            if status != noErr { diagnostics.bufferFailed(status: status); return nil }
        }
        guard let format = outputFormat else { return nil }
        let length = count * Int(Self.trackFormat.mBytesPerFrame)
        var block: CMBlockBuffer?
        if let bytes {
            // The writer keeps the buffer until it has encoded it: the frames are copied into pooled memory.
            var status = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: length,
                                                            blockAllocator: CMMemoryPoolGetAllocator(blocks), customBlockSource: nil,
                                                            offsetToData: 0, dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                            blockBufferOut: &block)
            if status == noErr, let block {
                status = CMBlockBufferReplaceDataBytes(with: bytes, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
            }
            if status != noErr { diagnostics.bufferFailed(status: status); return nil }
        } else {
            // Silence references one shared block of zeros, never freed and never written.
            let status = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: Silence.zeros, blockLength: length,
                                                            blockAllocator: kCFAllocatorNull, customBlockSource: nil, offsetToData: 0,
                                                            dataLength: length, flags: 0, blockBufferOut: &block)
            if status != noErr { diagnostics.bufferFailed(status: status); return nil }
        }
        var buffer: CMSampleBuffer?
        let pts = CMTimeAdd(start, CMTime(value: frame, timescale: CMTimeScale(Self.sampleRate)))
        guard let block else { return nil }
        let status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: count,
            presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &buffer)
        if status != noErr { diagnostics.bufferFailed(status: status); return nil }
        return buffer
    }

    // MARK: - Diagnostics

    /// A compact JSON diagnostic of the writer at `stage` (start, append, convert, finish): BroadcastWriterDiagnostics.
    func diagnostic(stage: String) -> String {
        lock.withLock {
            let downmix = normalizers.map(\.downmixStatus).first { $0 != noErr }
            return diagnostics.json(stage: stage, writer: writer, failed: failedTrack?.rawValue, downmix: downmix)
        }
    }
}

/// A shared block of zeros: `frames` of silence in `BroadcastCaptureWriter.trackFormat`.
private enum Silence {
    static let frames = 4_410
    static let zeros: UnsafeMutableRawPointer = {
        let bytes = frames * Int(BroadcastCaptureWriter.trackFormat.mBytesPerFrame)
        let p = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
        p.initializeMemory(as: UInt8.self, repeating: 0, count: bytes)
        return p
    }()
}

/// Converts linear PCM in any layout ReplayKit hands over (any rate, integer or float, either endianness,
/// interleaved or not, any channel count) to `BroadcastCaptureWriter.trackFormat`, keeping the converter's state
/// from one buffer to the next so resampling is seamless. A new source format gets a new converter. The input
/// buffer list and output buffer are reused, grown only when a larger buffer comes.
private final class PCMNormalizer {
    private var converter: AudioConverterRef?
    private var source: AudioStreamBasicDescription?
    private var list: UnsafeMutableRawPointer?
    private var listCapacity = 0
    private(set) var output: UnsafeMutableRawPointer = UnsafeMutableRawPointer.allocate(byteCount: 8_192, alignment: 16)
    private var outputCapacity = 8_192
    /// The error of the last conversion (0: none, or the buffer wasn't PCM). Kept for the diagnostic.
    private(set) var lastStatus: OSStatus = noErr
    /// The converter's answer to "mix every channel into one" (0: mixing, or a mono source).
    private(set) var downmixStatus: OSStatus = noErr

    /// Returned by the input callback once it has handed its one buffer over: not an error, the end of this call.
    fileprivate static let drained: OSStatus = 0x64726e64 // 'drnd'

    deinit {
        if let converter { AudioConverterDispose(converter) }
        list?.deallocate()
        output.deallocate()
    }

    /// Converts `sampleBuffer` into `output`: the number of frames there, or nil if it can't be converted.
    func convert(_ sampleBuffer: CMSampleBuffer) -> Int? {
        lastStatus = noErr
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              var asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate > 0, asbd.mChannelsPerFrame > 0 else { return nil }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return 0 }

        if converter == nil || source.map({ !BroadcastWriterDiagnostics.same($0, asbd) }) ?? true {
            if let converter { AudioConverterDispose(converter) }
            converter = nil
            var target = BroadcastCaptureWriter.trackFormat
            var made: AudioConverterRef?
            let status = AudioConverterNew(&asbd, &target, &made)
            guard status == noErr, let made else { lastStatus = status; source = nil; return nil }
            if asbd.mChannelsPerFrame > 1 {
                // Mix every channel into the mono track rather than keep only the first.
                // If the converter refuses, it keeps the first channel: still audio, so it's noted, not fatal.
                var mix: UInt32 = 1
                downmixStatus = AudioConverterSetProperty(made, kAudioConverterPropertyPerformDownmix, UInt32(MemoryLayout<UInt32>.size), &mix)
            }
            converter = made
            source = asbd
        }
        guard let converter else { return nil }

        // The source buffers, in an AudioBufferList sized for the buffer's layout (reused).
        var needed = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard status == noErr, needed > 0 else { lastStatus = status; return nil }
        if needed > listCapacity {
            list?.deallocate()
            list = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: 16)
            listCapacity = needed
        }
        guard let list else { return nil }
        let abl = list.bindMemory(to: AudioBufferList.self, capacity: 1)
        var retained: CMBlockBuffer?
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: abl, bufferListSize: needed,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &retained)
        guard status == noErr else { lastStatus = status; return nil }

        // Room for every frame this buffer can become at the track's rate, plus what the resampler held back.
        let capacityFrames = Int((Double(frames) * Double(BroadcastCaptureWriter.sampleRate) / asbd.mSampleRate).rounded(.up)) + 1_024
        let capacityBytes = capacityFrames * Int(BroadcastCaptureWriter.trackFormat.mBytesPerFrame)
        if capacityBytes > outputCapacity {
            output.deallocate()
            output = UnsafeMutableRawPointer.allocate(byteCount: capacityBytes, alignment: 16)
            outputCapacity = capacityBytes
        }
        var out = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(capacityBytes), mData: output))
        var produced = UInt32(capacityFrames)
        var feed = Feed(list: abl, frames: UInt32(frames))
        status = withExtendedLifetime(retained) {
            AudioConverterFillComplexBuffer(converter, feedConverter, &feed, &produced, &out, nil)
        }
        guard status == noErr || status == Self.drained else {
            lastStatus = status
            AudioConverterReset(converter)
            return nil
        }
        return Int(produced)
    }
}

/// What the converter's input callback hands over: one buffer, once per FillComplexBuffer call.
private struct Feed {
    let list: UnsafeMutablePointer<AudioBufferList>
    let frames: UInt32
    var handedOver = false
}

private func feedConverter(
    _ converter: AudioConverterRef, _ packets: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>,
    _ descriptions: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?, _ context: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let feed = context?.assumingMemoryBound(to: Feed.self) else { packets.pointee = 0; return PCMNormalizer.drained }
    if feed.pointee.handedOver {
        packets.pointee = 0
        return PCMNormalizer.drained
    }
    let source = UnsafeMutableAudioBufferListPointer(feed.pointee.list)
    let target = UnsafeMutableAudioBufferListPointer(data)
    for index in 0..<min(source.count, target.count) { target[index] = source[index] }
    packets.pointee = feed.pointee.frames
    feed.pointee.handedOver = true
    return noErr
}

/// What the extension's writer was doing when it failed, for the app group's defaults (`lastWriterError`): os_log
/// can't be read off the phone, the group's defaults can. Counts, formats and error codes: no audio, no user or note ids. The two descriptions
/// (80 characters each) are the system's own error text, which for a file error can name the capture's random file name.
final class BroadcastWriterDiagnostics {
    private var appended: [Int] = [0, 0]
    private var dropped: [Int] = [0, 0]
    private var firstFormat: [String?] = [nil, nil]
    private var lastFormat: [AudioStreamBasicDescription?] = [nil, nil]
    private var formatChanged: [Bool] = [false, false]
    private var unconvertible: [Int] = [0, 0]
    private var converterStatus: [OSStatus] = [0, 0]
    private var silenceFrames: [Int64] = [0, 0]
    private var bufferFailures = 0
    private var bufferStatus: OSStatus = noErr

    /// The source format of a buffer about to be appended to track `i` (0 app, 1 mic): the first one is kept, a
    /// later different one noted.
    func saw(_ sampleBuffer: CMSampleBuffer, on i: Int) {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }
        if let last = lastFormat[i] {
            if !Self.same(last, asbd) { formatChanged[i] = true }
        } else {
            firstFormat[i] = Self.describe(asbd)
        }
        lastFormat[i] = asbd
    }

    func appended(on i: Int) { appended[i] += 1 }
    func dropped(on i: Int) { dropped[i] += 1 }
    /// A buffer that couldn't be converted, and the converter's status (0 if it wasn't the converter: not PCM).
    func unconvertible(on i: Int, status: OSStatus) {
        unconvertible[i] += 1
        if status != noErr { converterStatus[i] = status }
    }
    /// A sample buffer for the writer couldn't be made (CoreMedia's status): the frames are lost, and said so.
    func bufferFailed(status: OSStatus) {
        bufferFailures += 1
        bufferStatus = status
    }
    /// Frames of silence a track was filled with while the other advanced.
    func filled(_ frames: Int, on i: Int) { silenceFrames[i] += Int64(frames) }
    func appendedCount(_ i: Int) -> Int { appended[i] }
    var droppedTotal: Int { dropped.reduce(0, +) + unconvertible.reduce(0, +) }

    static func same(_ a: AudioStreamBasicDescription, _ b: AudioStreamBasicDescription) -> Bool {
        a.mSampleRate == b.mSampleRate && a.mFormatID == b.mFormatID && a.mFormatFlags == b.mFormatFlags
            && a.mBytesPerFrame == b.mBytesPerFrame && a.mChannelsPerFrame == b.mChannelsPerFrame
            && a.mBitsPerChannel == b.mBitsPerChannel && a.mBytesPerPacket == b.mBytesPerPacket
    }

    /// `rate/fourcc/0xflags/channels ch/bytes per frame B`, e.g. `44100/lpcm/0xe/2ch/4B`.
    static func describe(_ asbd: AudioStreamBasicDescription) -> String {
        let id = asbd.mFormatID
        let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8(truncatingIfNeeded: id >> $0))) }
        let printable = chars.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == " ") }
        let fourcc = printable ? String(chars) : String(id)
        return "\(Int(asbd.mSampleRate))/\(fourcc)/0x\(String(asbd.mFormatFlags, radix: 16))/\(asbd.mChannelsPerFrame)ch/\(asbd.mBytesPerFrame)B"
    }

    /// `domain/code` of `error` and every NSUnderlyingErrorKey below it, outermost first.
    static func errorChain(_ error: Error?) -> [String] {
        var chain: [String] = []
        var current = error.map { $0 as NSError }
        while let e = current, chain.count < 6 {
            chain.append("\(e.domain)/\(e.code)")
            current = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return chain
    }

    /// Compact JSON (a few hundred bytes) at `stage` (start, append, convert, finish): the writer's status, its
    /// error chain and the outermost and innermost descriptions, the track that failed, and per track [app, mic]:
    /// buffers appended (n), dropped (drop), unconvertible (bad), seconds of silence filled (fill), the first source
    /// format seen (fmt) and whether a later one differed (chg), and the converter's last error (conv, if any).
    func json(stage: String, writer: AVAssetWriter?, failed track: Int? = nil, downmix: OSStatus? = nil) -> String {
        let error = writer?.error.map { $0 as NSError }
        var deepest = error
        while let next = deepest?.userInfo[NSUnderlyingErrorKey] as? NSError { deepest = next }
        func short(_ s: String?) -> String { String((s ?? "").prefix(80)) }
        var info: [String: Any] = [
            "at": stage,
            "t": Int(Date().timeIntervalSince1970),
            "status": writer?.status.rawValue ?? -1,
            "err": Self.errorChain(error).joined(separator: "<"),
            "desc": short(error?.localizedDescription),
            "n": appended,
            "drop": dropped,
            "bad": unconvertible,
            "fill": silenceFrames.map { Int($0 / Int64(BroadcastCaptureWriter.sampleRate)) },
            "fmt": firstFormat.map { $0 ?? "-" },
            "chg": formatChanged,
        ]
        if let deepest, deepest !== error { info["desc2"] = short(deepest.localizedDescription) }
        if let track { info["input"] = track == 0 ? "app" : "mic" }
        if converterStatus.contains(where: { $0 != noErr }) { info["conv"] = converterStatus.map { Int($0) } }
        if bufferFailures > 0 { info["mk"] = [bufferFailures, Int(bufferStatus)] }
        if let downmix, downmix != noErr { info["dmix"] = Int(downmix) }
        guard let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "{\"at\":\"\(stage)\"}" }
        return json
    }
}
