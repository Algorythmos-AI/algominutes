import AVFoundation

/// The writer the broadcast extension captures into (BroadcastExtension/SampleHandler): one AAC `.m4a`, app
/// audio and microphone on two tracks. Compiled into the extension and the unit tests (project.yml), so the
/// tests exercise the configuration that ships.
struct BroadcastCaptureWriter {
    let writer: AVAssetWriter
    /// The other app's audio (`.audioApp`).
    let appInput: AVAssetWriterInput
    /// The microphone (`.audioMic`).
    let micInput: AVAssetWriterInput

    /// AAC, 44.1 kHz, mono, 64 kbps. The source format may differ (app audio is typically 48 kHz stereo, the
    /// microphone 16 kHz mono): the inputs convert on append.
    static let audioSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64_000,
    ]

    /// How often the writer puts a movie fragment on disk (I3, N4). A plain `.m4a` gets its index (the moov
    /// atom) only from `finishWriting`, so an extension iOS killed mid-call (its ~50 MB memory limit, a hard
    /// stop, a crash) left a file nothing could open: the whole call lost. A fragmented file is readable up to
    /// its last fragment without `finishWriting`, so a kill costs at most these last seconds.
    static let fragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

    enum SetupError: Error { case cannotAddInput }

    /// A writer at `url`, not started. Two separate audio tracks: each input keeps its own monotonic timeline;
    /// mixing app and microphone into ONE input causes timestamp regressions and an unplayable file.
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
}

/// What the extension's writer was doing when it failed, for the app group's defaults (`lastWriterError`): os_log
/// can't be read off the phone, the group's defaults can. Counts and formats only: no audio, no ids, no paths.
final class BroadcastWriterDiagnostics {
    enum Track: Int { case app = 0, mic = 1 }

    private var appended: [Int] = [0, 0]
    private var dropped: [Int] = [0, 0]
    private var firstFormat: [String?] = [nil, nil]
    private var lastFormat: [AudioStreamBasicDescription?] = [nil, nil]
    private var formatChanged: [Bool] = [false, false]

    /// The source format of a buffer about to be appended to `track`: the first one is kept, a later different one noted.
    func saw(_ sampleBuffer: CMSampleBuffer, on track: Track) {
        let i = track.rawValue
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }
        if let last = lastFormat[i] {
            if !Self.same(last, asbd) { formatChanged[i] = true }
        } else {
            firstFormat[i] = Self.describe(asbd)
        }
        lastFormat[i] = asbd
    }

    func appended(on track: Track) { appended[track.rawValue] += 1 }
    func dropped(on track: Track) { dropped[track.rawValue] += 1 }

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

    /// Compact JSON (a few hundred bytes) at `stage` (start, append, finish): the writer's status, its error chain
    /// and the outermost and innermost descriptions, the track that failed, buffers appended and dropped per track
    /// [app, mic], the first source format each track saw and whether a later one differed.
    func json(stage: String, writer: AVAssetWriter?, failed track: Track? = nil) -> String {
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
            "fmt": firstFormat.map { $0 ?? "-" },
            "chg": formatChanged,
        ]
        if let deepest, deepest !== error { info["desc2"] = short(deepest.localizedDescription) }
        if let track { info["input"] = track == .app ? "app" : "mic" }
        guard let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "{\"at\":\"\(stage)\"}" }
        return json
    }
}
