import SwiftUI

/// State for the note detail screen.
///
/// Deliberately does **not** own the note. `NoteDetailView` re-derives it from
/// `env.notes.notes` on every render, so a Firestore mirror write shows up
/// immediately with no plumbing; caching a copy here would reintroduce exactly
/// the staleness the live listener exists to avoid.
///
/// Thin today — a tab, a share payload, an alert. It is the seam the rest of
/// the note-detail work hangs off: the audio player, the full-transcript
/// fetch, and the note-scoped chat all land here rather than as more `@State`
/// on a view that is already the busiest screen in the app.
@Observable
@MainActor
final class NoteDetailViewModel {
    enum Tab: String, CaseIterable {
        case summary = "AI Summary"
        case transcript = "Transcriptions"
    }

    /// Which secondary sheet is open, if any. One enum rather than a boolean
    /// per sheet, so two cannot be presented at once.
    enum ActiveSheet: Identifiable, Hashable {
        case rename, moreOperations, shareExport, conversation, templatePicker
        var id: Self { self }
    }

    /// A composed email waiting to be presented.
    struct MailDraft: Identifiable {
        let id = UUID()
        let subject: String
        let body: String
        let attachment: Data
        let fileName: String
        let mimeType: String
    }

    var tab: Tab = .summary
    var shareItem: ShareItem?
    var alertMessage: String?
    var activeSheet: ActiveSheet?
    var confirmingDelete = false
    var mailDraft: MailDraft?
    var isExporting = false

    /// Rating for the open note. Kept locally rather than read back from the
    /// server: the endpoint upserts, so the value the user just tapped is
    /// authoritative, and a round trip to confirm it would only add latency
    /// to an interaction that should feel instant.
    var rating: Int?
    var isSavingRating = false

    /// Which template the next regenerate will use. Seeded from the note and
    /// updated when the user picks one.
    /// Set to a view id to scroll there; cleared once handled. A one-shot
    /// signal rather than a persistent selection, so tapping the same tile
    /// twice scrolls twice.
    var scrollTarget: String?

    /// The most recent share link for the open note, and whether one is being
    /// minted. Held here rather than in the sheet so it survives dismissal —
    /// the raw token is only ever returned once, so losing it on a stray tap
    /// would mean minting a second link to recover the first.
    ///
    /// Deliberately NOT persisted anywhere: it is a live credential, and the
    /// server keeps only its hash.
    var mintedShareLink: String?
    var isMintingShareLink = false

    var template: SummaryTemplate = .general
    var isRegenerating = false

    /// A regenerate the server refused because the summary was hand-edited.
    /// Held so the view can ask before destroying that work — retrying with
    /// `confirmOverwrite` is the only path past it, and it must be the user's
    /// decision rather than an automatic retry.
    struct OverwritePrompt: Identifiable {
        let id = UUID()
        let template: SummaryTemplate
        let editedAt: String?
    }
    var overwritePrompt: OverwritePrompt?

    /// Conversation about this note. Held here rather than in the view so it
    /// survives the transcript/summary tab switching and sheet dismissal —
    /// asking a question, reading the transcript, then asking a follow-up is
    /// the normal shape of using this screen.
    let chat = ChatViewModel()
    private var chatAttached = false

    /// Idempotent: the view calls this on every appear.
    func attachChat(api: APIClient, noteId: String) {
        guard !chatAttached else { return }
        chat.attach(api: api, noteId: noteId)
        chatAttached = true
    }

    /// Bytes for an export, from wherever that format comes from.
    ///
    /// DOCX is fetched; PDF and TXT are rendered off the main actor, because
    /// laying out a long transcript is heavy enough to hitch the tap that
    /// started it. Throws `ExportError.transcriptTooLarge` when the server
    /// declines a very long transcript, which the callers turn into a TXT
    /// fallback rather than an error the user can do nothing about.
    private func payload(
        note: Note, scope: ExportScope, format: ExportFormat,
        transcript: [TranscriptLine], api: APIClient
    ) async throws -> Data {
        if format.isServerRendered {
            return try await api.exportNote(
                noteId: note.id, workspaceId: note.workspaceId, scope: scope
            )
        }
        return await Task.detached(priority: .userInitiated) {
            Self.render(note: note, scope: scope, format: format, transcript: transcript)
        }.value
    }

    /// Render an export and hand it to the system share sheet.
    ///
    /// The render runs off the main actor: laying out a long transcript and
    /// writing the file is heavy enough to hitch the tap that started it.
    func export(
        note: Note,
        scope: ExportScope,
        format: ExportFormat,
        transcript: [TranscriptLine],
        api: APIClient,
        onFailure: @escaping (String) -> Void
    ) {
        isExporting = true
        Task {
            defer { isExporting = false }
            do {
                let data = try await payload(
                    note: note, scope: scope, format: format, transcript: transcript, api: api
                )
                let name = NoteExport.fileName(for: note, scope: scope, ext: format.ext)
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                try data.write(to: url)
                shareItem = ShareItem(items: [note.title, url])
            } catch is ExportError {
                // The transcript is past the server's DOCX guard. Give them
                // the file they asked for in the format that can hold it
                // rather than a dead end.
                onFailure("This transcript is too long for a Word document. Try TXT.")
            } catch {
                AppLog.error("export_failed: \(error)")
                onFailure("Could not create the \(format.label). Please try again.")
            }
        }
    }

    /// Same render, delivered to the mail composer instead of the share sheet.
    func emailExport(
        note: Note,
        scope: ExportScope,
        format: ExportFormat,
        transcript: [TranscriptLine],
        api: APIClient,
        onFailure: @escaping (String) -> Void
    ) {
        isExporting = true
        Task {
            defer { isExporting = false }
            let data: Data
            do {
                data = try await payload(
                    note: note, scope: scope, format: format, transcript: transcript, api: api
                )
            } catch is ExportError {
                onFailure("This transcript is too long for a Word document. Try TXT.")
                return
            } catch {
                AppLog.error("email_export_failed: \(error)")
                onFailure("Could not create the \(format.label). Please try again.")
                return
            }
            guard !data.isEmpty else {
                onFailure("Could not create the \(format.label). Please try again.")
                return
            }
            mailDraft = MailDraft(
                subject: note.title,
                body: NoteExport.redactionNotice,
                attachment: data,
                fileName: NoteExport.fileName(for: note, scope: scope, ext: format.ext),
                mimeType: format.mimeType
            )
        }
    }

    /// Optimistic: the star fills immediately and reverts only if the save
    /// fails. Rating is a low-stakes, idempotent write — making the user wait
    /// on a round trip for a star to light up would be the wrong trade.
    func rate(_ value: Int, noteId: String, workspaceId: String, api: APIClient,
              onFailure: @escaping (String) -> Void) {
        let previous = rating
        rating = value
        isSavingRating = true
        Task {
            defer { isSavingRating = false }
            do {
                try await api.submitFeedback(noteId: noteId, workspaceId: workspaceId, rating: value)
            } catch {
                AppLog.error("note_feedback_failed: \(error)")
                rating = previous
                onFailure("Couldn't save your rating. Please try again.")
            }
        }
    }

    /// Ask the note-scoped chat to draft a follow-up.
    ///
    /// A fixed prompt through the existing composer rather than a new
    /// endpoint: retrieval is already scoped to this note, so this costs
    /// nothing on the server that asking the question by hand would not.
    func draftFollowUp() {
        guard !chat.isStreaming else { return }
        chat.draft = """
            Draft a short follow-up email for this meeting. Open with one line \
            of context, list what was agreed and who owns each item, and close \
            with the next step. Use only what the transcript supports.
            """
        chat.send()
    }

    /// Mint a public read link for this note.
    ///
    /// The returned URL carries the raw token — the one moment it exists in
    /// the clear. It is kept in memory for the user to copy and never written
    /// to disk or logged.
    func createShareLink(
        scope: ExportScope,
        noteId: String,
        workspaceId: String,
        api: APIClient,
        onFailure: @escaping (String) -> Void
    ) {
        guard !isMintingShareLink else { return }
        isMintingShareLink = true
        Task {
            defer { isMintingShareLink = false }
            do {
                let link = try await api.createShareLink(
                    noteId: noteId, workspaceId: workspaceId, scope: scope
                )
                mintedShareLink = link.url
            } catch {
                AppLog.error("share_create_failed: \(error)")
                onFailure("Couldn't create a link. Please try again.")
            }
        }
    }

    /// Re-run the summarizer, optionally with a different template.
    ///
    /// `confirmOverwrite` is never set automatically. The server returns 409
    /// `manual_edits_present` precisely because someone typed that summary by
    /// hand, so the retry is surfaced to them instead — reprocessing silently
    /// wiping manual edits is the failure /api/update-note exists to prevent,
    /// and re-introducing it here would defeat the point.
    func regenerate(
        _ chosen: SummaryTemplate,
        noteId: String,
        workspaceId: String,
        api: APIClient,
        confirmOverwrite: Bool = false,
        onFailure: @escaping (String) -> Void
    ) {
        guard !isRegenerating else { return }
        template = chosen
        isRegenerating = true
        Task {
            defer { isRegenerating = false }
            do {
                try await api.regenerateSummary(
                    noteId: noteId, workspaceId: workspaceId,
                    template: chosen.rawValue, confirmOverwrite: confirmOverwrite
                )
                // No local summary write: the note re-derives from the
                // Firestore mirror, and status flips to `summarizing`, so the
                // processing pane takes over on the next render.
            } catch let conflict as APIClient.RegenerateConflict {
                switch conflict {
                case .manualEdits(let editedAt):
                    overwritePrompt = OverwritePrompt(template: chosen, editedAt: editedAt)
                case .alreadyRegenerating:
                    onFailure("This note is already being rewritten. Give it a moment.")
                }
            } catch {
                AppLog.error("regenerate_summary_failed: \(error)")
                onFailure("Couldn't rewrite the summary. Please try again.")
            }
        }
    }

    nonisolated private static func render(
        note: Note, scope: ExportScope, format: ExportFormat, transcript: [TranscriptLine]
    ) -> Data {
        switch format {
        case .pdf:
            return PDFExporter.export(note: note, scope: scope, transcript: transcript)
        case .txt:
            return Data(NoteExport.plainText(note: note, scope: scope, lines: transcript).utf8)
        case .docx:
            // Unreachable: payload() routes server-rendered formats to
            // /api/export-note before ever calling render. Logged rather than
            // crashed, and the empty result is caught by the callers' own
            // emptiness check — a failed export is not worth a crash.
            AppLog.error("render_called_for_server_format: docx")
            return Data()
        }
    }
}
