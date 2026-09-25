import FirebaseFirestore
import Foundation

/// Realtime notes over Firestore — parity with the listener, watchdog,
/// auto-retitle, and retry orchestration in `src/App.tsx`.
@Observable
@MainActor
final class NotesRepository {
    private(set) var notes: [Note] = []
    private(set) var listenerHealthy = true

    private let api: APIClient
    private var listener: ListenerRegistration?
    private var watchdogTimer: Timer?
    private var resubscribeAttempts = 0
    private var resubscribeTask: Task<Void, Never>?

    private var uid: String?
    private var wsId: String?

    /// Once-per-session guards (parity with the web refs).
    private var stuckCheckRan = Set<String>()
    private var retitleAttempted = Set<String>()
    private var retryInFlight = Set<String>()

    /// A7.3: previous per-note status, to detect a completion transition and post
    /// the local-notification fallback exactly once. Empty until the first
    /// snapshot so an app launch that finds already-finished notes stays silent.
    private var lastStatusById: [String: NoteStatus] = [:]
    private var receivedFirstSnapshot = false

    static let maxRetryAttempts = 3

    init(api: APIClient) {
        self.api = api
    }

    private var db: Firestore { Firestore.firestore() }

    private func notesCollection() -> CollectionReference? {
        guard let wsId else { return nil }
        return db.collection("workspaces").document(wsId).collection("notes")
    }

    // MARK: - Listener lifecycle

    func start(uid: String, workspaceId: String) {
        stop()
        self.uid = uid
        self.wsId = workspaceId
        subscribe()
        startWatchdog()
    }

    func stop() {
        listener?.remove()
        listener = nil
        resubscribeTask?.cancel()
        resubscribeTask = nil
        watchdogTimer?.invalidate()
        watchdogTimer = nil
        notes = []
        uid = nil
        wsId = nil
        stuckCheckRan.removeAll()
        retitleAttempted.removeAll()
        retryInFlight.removeAll()
        lastStatusById.removeAll()
        receivedFirstSnapshot = false
        resubscribeAttempts = 0
    }

    private func subscribe() {
        guard let uid, let collection = notesCollection() else { return }
        listener = collection
            .whereField("authorId", isEqualTo: uid)
            .addSnapshotListener { [weak self] snapshot, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let error {
                        AppLog.error("notes_listener_failed: \(error.localizedDescription)")
                        self.listenerHealthy = false
                        self.scheduleResubscribe()
                        return
                    }
                    guard let snapshot else { return }
                    self.listenerHealthy = true
                    self.resubscribeAttempts = 0
                    let parsed = snapshot.documents.compactMap { Note(id: $0.documentID, data: $0.data()) }
                    self.notifyCompletedTransitions(newNotes: parsed)
                    self.notes = parsed.sorted { $0.createdAt > $1.createdAt }
                    self.autoRetitleReadyNotes()
                }
            }
    }

    /// Pull-to-refresh: re-attach the realtime listener and give it a moment to
    /// deliver a fresh snapshot. The listener is already realtime, so this is a
    /// user-reassurance affordance (and recovers a silently-dropped listener).
    func refresh() async {
        listener?.remove()
        listener = nil
        subscribe()
        try? await Task.sleep(for: .milliseconds(400))
    }

    /// Exponential backoff resubscribe: min(60s, 1s * 2^attempts).
    private func scheduleResubscribe() {
        listener?.remove()
        listener = nil
        let delay = min(60.0, pow(2.0, Double(resubscribeAttempts)))
        resubscribeAttempts += 1
        resubscribeTask?.cancel()
        resubscribeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.subscribe()
        }
    }

    // MARK: - Note CRUD

    /// Creates the note doc and returns its id (client-generated, parity with
    /// `doc(collection(...))` then `setDoc`).
    func createNote(fields: [String: Any]) throws -> String {
        guard let collection = notesCollection(), let uid, let wsId else {
            throw APIError.notSignedIn
        }
        let ref = collection.document()
        var data = fields
        data["workspaceId"] = wsId
        data["authorId"] = uid
        data["createdAt"] = Note.isoNow()
        data["updatedAt"] = Note.isoNow()
        ref.setData(data) { error in
            if let error {
                AppLog.error("note_create_failed: \(error.localizedDescription)")
            }
        }
        return ref.documentID
    }

    func updateNote(id: String, fields: [String: Any]) {
        guard let collection = notesCollection() else { return }
        var data = fields
        data["updatedAt"] = Note.isoNow()
        collection.document(id).updateData(data) { error in
            if let error {
                AppLog.error("note_update_failed: \(error.localizedDescription)")
            }
        }
    }

    func markNoteError(id: String, message: String) {
        updateNote(id: id, fields: ["status": NoteStatus.error.rawValue, "errorMessage": message])
    }

    /// A7.3: post the local `note_ready` / `note_failed` fallback when a note
    /// crosses from in-progress to a terminal state. Only fires on a genuine
    /// transition seen after the first snapshot, so relaunching into a
    /// backlog of finished notes stays silent. `RecordingNotifier` itself
    /// suppresses the banner while the app is foregrounded.
    private func notifyCompletedTransitions(newNotes: [Note]) {
        defer {
            lastStatusById = Dictionary(newNotes.map { ($0.id, $0.status) }, uniquingKeysWith: { _, new in new })
            receivedFirstSnapshot = true
        }
        guard receivedFirstSnapshot else { return }
        for note in newNotes {
            guard let previous = lastStatusById[note.id], previous.isInProgress else { continue }
            switch note.status {
            case .ready:
                RecordingNotifier.noteFinished(noteId: note.id, title: note.title, ready: true)
            case .error:
                RecordingNotifier.noteFinished(noteId: note.id, title: note.title, ready: false)
            default:
                break
            }
        }
    }

    /// Deleting the doc triggers the backend `onNoteDeleted` cascade.
    func deleteNote(id: String) {
        guard let collection = notesCollection() else { return }
        collection.document(id).delete { error in
            if let error {
                AppLog.error("note_delete_failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Retry (parity with retryProcessing)

    enum RetryOutcome: Equatable {
        case queued
        case blocked(message: String)
    }

    func retryProcessing(note: Note) async -> RetryOutcome {
        guard let wsId else { return .blocked(message: "Not signed in") }
        guard !retryInFlight.contains(note.id) else { return .queued }

        let currentAttempts = note.retryAttempt ?? 0
        guard currentAttempts < Self.maxRetryAttempts else {
            return .blocked(message: "We've already tried this \(currentAttempts) times. Please try uploading the file directly, or contact support if the problem persists.")
        }
        let nextAttempt = currentAttempts + 1

        var request = APIClient.ProcessAudioRequest(
            noteId: note.id,
            workspaceId: wsId,
            type: note.type,
            retryAttempt: nextAttempt,
            durationSec: note.duration
        )
        if note.type == .youtube {
            guard let sourceUrl = note.sourceUrl, !sourceUrl.isEmpty else {
                markNoteError(id: note.id, message: "Original YouTube link is missing. Please import the URL again.")
                return .blocked(message: "Original YouTube link is missing. Please import the URL again.")
            }
            request.sourceUrl = sourceUrl
        } else {
            // iOS captures/uploads .m4a (audio/mp4) — the old .webm defaults were
            // web-app leftovers that pointed retry at a path that never existed.
            request.storagePath = note.storagePath
                ?? StoragePaths.path(kind: .recording, workspaceId: wsId, noteId: note.id, ext: "m4a")
            request.mimeType = note.mimeType ?? "audio/mp4"
        }

        retryInFlight.insert(note.id)
        defer { retryInFlight.remove(note.id) }

        // Re-arm the watchdog: this note is moving back in-progress and must be
        // eligible to be flipped again if it gets stuck a second time.
        resetStuckGuard(noteId: note.id)

        updateNote(id: note.id, fields: [
            "status": NoteStatus.queued.rawValue,
            "errorMessage": NSNull(),
            "retryAttempt": nextAttempt,
        ])

        do {
            try await api.processAudio(request)
            return .queued
        } catch {
            AppLog.error("retry_kickoff_failed: \(error.localizedDescription)")
            markNoteError(id: note.id, message: "Could not queue this retry. Please try again.")
            return .blocked(message: "Could not queue this retry. Please try again.")
        }
    }

    // MARK: - Stuck-note watchdog (parity with App.tsx)

    private func startWatchdog() {
        watchdogTimer = Timer.scheduledTimer(withTimeInterval: StuckBudgets.checkInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.runWatchdogPass()
            }
        }
    }

    func runWatchdogPass(now: Date = Date()) {
        for note in notes where StuckBudgets.isStuck(note: note, now: now) {
            guard !stuckCheckRan.contains(note.id) else { continue }
            stuckCheckRan.insert(note.id)
            flipStuckToError(note: note)
        }
    }

    /// Re-arms the once-per-session stuck guard for a note that is being
    /// retried. Without this, a note the watchdog already flipped to error once
    /// stays in `stuckCheckRan` forever, so if the retry gets stuck again the
    /// watchdog can never flip it back — the note spins indefinitely.
    func resetStuckGuard(noteId: String) {
        stuckCheckRan.remove(noteId)
    }

    /// Transaction: only flip when the status is unchanged server-side.
    private func flipStuckToError(note: Note) {
        guard let collection = notesCollection() else { return }
        let ref = collection.document(note.id)
        let expectedStatus = note.status.rawValue
        db.runTransaction({ transaction, errorPointer -> Any? in
            let snapshot: DocumentSnapshot
            do {
                snapshot = try transaction.getDocument(ref)
            } catch let error as NSError {
                errorPointer?.pointee = error
                return nil
            }
            guard let status = snapshot.data()?["status"] as? String, status == expectedStatus else {
                return nil // backend already progressed — bail
            }
            transaction.updateData([
                "status": NoteStatus.error.rawValue,
                "errorMessage": "Processing took too long. Please try again.",
                "diagnosticCode": "CLIENT_TIMEOUT",
                "updatedAt": Note.isoNow(),
            ], forDocument: ref)
            return nil
        }) { _, error in
            if let error {
                AppLog.error("watchdog_flip_failed: \(error.localizedDescription)")
            } else {
                AppLog.info("watchdog_flipped_stuck_to_error noteId=\(note.id)")
            }
        }
    }

    // MARK: - Auto-retitle (parity with App.tsx)

    private func autoRetitleReadyNotes() {
        for note in notes where note.status == .ready && TitleDeriver.isPlaceholder(note.title) {
            guard !retitleAttempted.contains(note.id) else { continue }
            guard let title = TitleDeriver.derive(fromGist: note.summary?.gist) else { continue }
            retitleAttempted.insert(note.id)
            guard let collection = notesCollection() else { return }
            collection.document(note.id).updateData([
                "title": title,
                "updatedAt": Note.isoNow(),
            ]) { [weak self] error in
                if let error {
                    AppLog.error("retitle_failed: \(error.localizedDescription)")
                    Task { @MainActor in
                        self?.retitleAttempted.remove(note.id) // allow retry, parity with web
                    }
                }
            }
        }
    }
}

/// Minimal structured logging for the client. (Server-side logging invariants
/// don't apply to the iOS app, but keep messages greppable.)
enum AppLog {
    static func info(_ message: String) {
        #if DEBUG
        print("[AlgoMinutes] \(message)")
        #endif
    }

    static func error(_ message: String) {
        print("[AlgoMinutes][error] \(message)")
    }
}
