import AVFoundation
import Foundation

/// Is this recording actually playable, and how long is it?
///
/// Nothing checked this before. A recording orphaned by a force-quit or a
/// memory kill was accepted on `size > 0` alone and offered to the doctor as
/// "Upload it", even though the audio it claims to hold may not be in the file.
/// Uploading it looks like success and loses the consultation.
///
/// **Metadata alone cannot answer this**, which is the reason for the sample
/// read below. Dumping the atom layout of a file written by this app's settings
/// shows `ftyp` and `moov` near the front and `mdat` starting around 72% in, so
/// a file whose tail is missing still parses, still answers `isPlayable`, and
/// still reports its full duration from the header — while the samples that
/// header describes are gone. A 3-second recording cut to 60% passed every
/// metadata check. Only decoding catches it.
///
/// **And a damaged file is not recoverable.** MPEG-4 needs `moov`'s `stsz`
/// sample sizes and `stco` chunk offsets to locate frame boundaries; unlike
/// ADTS, the raw AAC access units carry no length prefixes and no sync words,
/// so there is nothing to resynchronise against. `AVAssetExportSession` needs a
/// readable asset to begin with, and Apple ships no repair API. So the honest
/// behaviour is to say the file is damaged and keep it — never to delete it
/// quietly, and never to pretend it will upload.
enum RecordingValidator {
    struct Verdict: Equatable {
        let isPlayable: Bool
        /// Only set when playable. Feeds the note's `duration`, which the
        /// stuck-note watchdog uses to size its budget.
        let durationSeconds: Int?
    }

    /// Below this a file is a container with no meaningful audio in it.
    static let minDurationSeconds = 1.0

    static func validate(_ url: URL) async -> Verdict {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return Verdict(isPlayable: false, durationSeconds: nil)
        }

        let asset = AVURLAsset(url: url)
        do {
            // All three checks are needed, in this order. A file with no moov
            // atom usually *throws* here rather than returning false, an asset
            // can report playable while carrying no audio track, and a track
            // can exist with a zero or non-finite duration.
            let playable = try await asset.load(.isPlayable)
            guard playable else { return Verdict(isPlayable: false, durationSeconds: nil) }

            let tracks = try await asset.loadTracks(withMediaType: .audio)
            guard !tracks.isEmpty else { return Verdict(isPlayable: false, durationSeconds: nil) }

            let duration = try await asset.load(.duration)
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds >= minDurationSeconds else {
                return Verdict(isPlayable: false, durationSeconds: nil)
            }

            // Metadata is not enough. AVAudioRecorder lays the file out with its
            // header near the front and the audio (`mdat`) after it, so a file
            // whose tail was lost still answers "playable" and still reports the
            // full duration from the header — while the samples it describes are
            // simply not there. Measured, not assumed: a 3-second recording
            // truncated to 60% passed every check above.
            //
            // So decode one buffer. If the audio is real this costs a few
            // milliseconds; if it is missing, this is the only thing that says so.
            guard try await canReadSamples(from: asset, track: tracks[0]) else {
                AppLog.info("recording_no_readable_samples file=\(url.lastPathComponent)")
                return Verdict(isPlayable: false, durationSeconds: nil)
            }

            return Verdict(isPlayable: true, durationSeconds: Int(seconds.rounded()))
        } catch {
            // A throw here is the normal outcome for an unfinalised file, not an
            // exceptional one — log it as information rather than an error.
            AppLog.info("recording_unplayable file=\(url.lastPathComponent) reason=\(error.localizedDescription)")
            return Verdict(isPlayable: false, durationSeconds: nil)
        }
    }

    /// Can we actually decode audio out of this file, or does only its header
    /// claim to have some?
    ///
    /// Reads a single buffer and stops. `AVAssetReader` reports `.failed` when
    /// the samples the header describes are not present in the file.
    private static func canReadSamples(from asset: AVURLAsset, track: AVAssetTrack) async throws -> Bool {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM]
        )
        guard reader.canAdd(output) else { return false }
        reader.add(output)
        guard reader.startReading() else { return false }
        defer { reader.cancelReading() }

        let sample = output.copyNextSampleBuffer()
        if reader.status == .failed { return false }
        guard let sample else { return false }
        return CMSampleBufferGetNumSamples(sample) > 0
    }

    /// Shown when a recording cannot be played. It deliberately does not offer
    /// to delete: the bytes are a few tens of megabytes, and for a medical
    /// record keeping the option of an offline recovery attempt is worth more
    /// than the space.
    static let damagedMessage =
        "This recording was interrupted when the app closed unexpectedly, so it can't be "
        + "played or uploaded. It's still saved on this device — please get in touch before "
        + "deleting it."
}
