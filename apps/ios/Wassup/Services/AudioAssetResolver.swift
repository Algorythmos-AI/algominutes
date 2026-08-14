import Foundation

/// Where a note's audio should be played from.
enum AudioSource: Equatable, Sendable {
    /// The recording is still on disk — it has not finished uploading, or the
    /// upload has not been confirmed yet. Playing this avoids waiting on a
    /// round trip for audio that is sitting right here.
    case local(URL)
    /// Stream from Storage at this path.
    case remote(storagePath: String)
    /// This note has no audio at all — scans, PDFs, YouTube imports.
    case none
}

/// Decides where audio comes from, kept pure so the decision table is
/// testable without Firebase, a filesystem, or a network.
enum AudioAssetResolver {
    /// - Parameters:
    ///   - localFileURL: a pending recording's file, if one exists on disk.
    ///   - storagePath: `recordings/{workspace}/{noteId}.m4a` once uploaded.
    ///   - type: the note's source type.
    static func decide(localFileURL: URL?, storagePath: String?, type: NoteType) -> AudioSource {
        // Local first, unconditionally. AppEnvironment deletes the file only
        // after a *confirmed* upload, so if it is still here it is the same
        // audio and needs no network.
        if let localFileURL { return .local(localFileURL) }
        guard type.hasAudio, let storagePath, !storagePath.isEmpty else { return .none }
        return .remote(storagePath: storagePath)
    }
}

extension NoteType {
    /// Whether this kind of note has an audio file behind it at all.
    ///
    /// Scans and PDFs do have a `storagePath`, but it points at an image or a
    /// document — handing that to AVPlayer would fail at decode time rather
    /// than simply not offering a player. YouTube imports keep their source
    /// in `sourceUrl`; the extracted audio is server-side only.
    var hasAudio: Bool {
        switch self {
        case .recording, .importAudio, .onlineMeeting: return true
        case .importPdf, .scanText, .youtube: return false
        }
    }
}

extension Note {
    /// Whether the player card should be offered for this note.
    var hasPlayableAudio: Bool {
        type.hasAudio && !(storagePath ?? "").isEmpty
    }
}
