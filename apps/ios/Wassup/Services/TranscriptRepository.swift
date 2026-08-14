import Foundation
import Observation

/// Fetches a note's complete transcript from `/api/note`.
///
/// The Firestore listener mirrors only the first 200 lines, so anything longer
/// has always been silently cut off. This pages the rest in.
///
/// Failure is never fatal: the mirrored lines are already on screen and stay
/// there, so a fetch that fails degrades to "showing the first 200" with a
/// retry rather than emptying the transcript the user was reading.
@Observable
@MainActor
final class TranscriptRepository {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(totalLines: Int)
        case failed
    }

    private(set) var state: LoadState = .idle
    private(set) var lines: [TranscriptLine] = []
    /// The note `lines` belongs to, so a stale response from a previous note
    /// cannot be rendered against the current one.
    private(set) var noteId: String?

    /// Ceiling on paging. A 2-hour meeting is ~3-6k lines; 20k is far past any
    /// real transcript and exists so a server-side cursor bug cannot spin here
    /// forever.
    private static let maxPages = 20

    private let api: APIClient
    private var task: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    /// Load the full transcript, replacing whatever is held.
    ///
    /// Idempotent per note: calling again for a note already loaded or in
    /// flight is a no-op, so a view that re-appears does not re-fetch.
    func loadFull(noteId: String, workspaceId: String) {
        if self.noteId == noteId, state == .loading { return }
        if self.noteId == noteId, case .loaded = state { return }

        task?.cancel()
        self.noteId = noteId
        lines = []
        state = .loading

        task = Task { [api] in
            var collected: [TranscriptLine] = []
            var cursor: String?
            var pages = 0

            do {
                repeat {
                    let page = try await api.fetchTranscriptPage(
                        noteId: noteId, workspaceId: workspaceId, cursor: cursor
                    )
                    if Task.isCancelled { return }
                    // Ordinals continue across pages so identity stays
                    // positional and matches the mirrored prefix.
                    for line in page.lines {
                        collected.append(line.asTranscriptLine(index: collected.count))
                    }
                    cursor = page.nextCursor
                    pages += 1
                } while cursor != nil && pages < Self.maxPages

                if Task.isCancelled { return }
                self.lines = collected
                self.state = .loaded(totalLines: collected.count)
                AppLog.info("transcript_full_loaded lines=\(collected.count) pages=\(pages)")
            } catch {
                if Task.isCancelled { return }
                AppLog.error("transcript_full_failed: \(error)")
                self.state = .failed
            }
        }
    }

    /// Which lines the transcript pane should render.
    func displayLines(mirrored: [TranscriptLine]?, for noteId: String) -> [TranscriptLine] {
        Self.preferred(full: lines, fullNoteId: self.noteId, mirrored: mirrored, noteId: noteId)
    }

    /// The choice between the mirrored preview and the fetched transcript,
    /// kept pure so it can be tested without a network or a live repository.
    ///
    /// Prefers the full set once it has landed and is genuinely longer.
    /// Both conditions matter:
    ///
    ///   - the note ids must match, or a response still in flight for the
    ///     previous note would render against this one;
    ///   - the full set must be *longer*, because a short note's mirror
    ///     already is the whole transcript and swapping it for an identical
    ///     fetch would rebuild the list — losing scroll position — for nothing.
    /// `nonisolated` because it touches no state — it is a decision over its
    /// arguments, and isolating it would force callers onto the main actor for
    /// no reason.
    nonisolated static func preferred(
        full: [TranscriptLine],
        fullNoteId: String?,
        mirrored: [TranscriptLine]?,
        noteId: String
    ) -> [TranscriptLine] {
        guard fullNoteId == noteId, full.count > (mirrored?.count ?? 0) else {
            return mirrored ?? []
        }
        return full
    }
}
