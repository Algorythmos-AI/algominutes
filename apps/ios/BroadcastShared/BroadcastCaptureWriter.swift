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
