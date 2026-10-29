import Foundation

/// What recovering a recording that never confirmed its upload does with it: from Home › "Not yet uploaded" ›
/// Upload, the orphan prompt, and every launch (AppEnvironment.recoverRecording, resumePendingUploads).
/// RecordingRecoveryTests.
enum RecoveryPlan: Equatable {
    /// The audio is no longer on this iPhone: forget the recording.
    case gone
    /// Re-upload into the note it already belongs to (never a duplicate).
    case reupload(noteId: String)
    /// Make a new note from it: it never got one, or its note belongs to another backend.
    case newNote(fromOtherBackend: Bool)

    static func decide(
        _ recording: RecordingStore.PendingRecording, fileExists: Bool, currentProjectId: String?
    ) -> RecoveryPlan {
        guard fileExists else { return .gone }
        guard let noteId = recording.noteId else { return .newNote(fromOtherBackend: false) }
        // Only a recording that says which backend it was made for, and says another one, is moved. One written
        // before the stamp isn't guessed at: the server answers a note id it doesn't know with a 404, which
        // reupload already turns into a new note.
        if let current = currentProjectId, let made = recording.projectId, made != current {
            return .newNote(fromOtherBackend: true)
        }
        return .reupload(noteId: noteId)
    }
}
