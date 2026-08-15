import SwiftUI
import UIKit

/// The note screen: title, then whichever pane the note's status calls for.
///
/// Structure only — this file routes and hosts; the panes render. It was one
/// 270-line file with the summary, transcript, processing and error states
/// inlined, which is fine for four states and one toolbar action and stops
/// being fine the moment a player, a quick-action row, a scoped composer and
/// four sheets arrive.
struct NoteDetailView: View {
    @Environment(AppEnvironment.self) private var env
    let noteId: String

    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = NoteDetailViewModel()

    /// Re-derived every render rather than captured. The Firestore listener is
    /// the source of truth for the screen, so a mirror write — a status change,
    /// a summary landing, an auto-retitle — reflects here with no plumbing.
    private var note: Note? {
        env.notes.notes.first { $0.id == noteId }
    }

    var body: some View {
        Group {
            if let note {
                content(note)
            } else {
                EmptyStateView(icon: "doc.questionmark", message: "This note is no longer available.")
            }
        }
        .background(OwllBackground())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let note {
                ToolbarItem(placement: .topBarTrailing) {
                    if note.status == .ready {
                        Button {
                            viewModel.activeSheet = .shareExport
                        } label: {
                            if viewModel.isExporting {
                                ProgressView()
                            } else {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                        .disabled(viewModel.isExporting)
                        .accessibilityLabel("Share and export")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.activeSheet = .moreOperations
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More operations")
                }
            }
        }
        .sheet(item: $viewModel.shareItem) { item in
            ActivityShareSheet(items: item.items)
        }
        .sheet(item: $viewModel.activeSheet) { sheet in
            if let note {
                switch sheet {
                case .rename:
                    NoteNameSheet(
                        title: "Rename",
                        prompt: "Give this note a name you'll recognise later.",
                        initialName: note.title,
                        currentName: note.title,
                        confirmLabel: "Save"
                    ) { newTitle in
                        await env.renameNote(noteId: note.id, to: newTitle)
                    }
                    .algoMinutesSheet([.medium])
                case .moreOperations:
                    MoreOperationsSheet(
                        note: note,
                        onRename: { viewModel.activeSheet = .rename },
                        onCopy: { copy(note) },
                        onPrint: { NotePrinter.print(note: note) { env.alertMessage = $0 } },
                        onRegenerate: { viewModel.activeSheet = .templatePicker },
                        onDelete: { viewModel.confirmingDelete = true }
                    )
                    .algoMinutesSheet([.medium])
                case .templatePicker:
                    TemplatePickerSheet(
                        current: viewModel.template,
                        isRunning: viewModel.isRegenerating
                    ) { chosen in
                        viewModel.regenerate(
                            chosen, noteId: note.id, workspaceId: note.workspaceId, api: env.api
                        ) { env.alertMessage = $0 }
                    }
                    .algoMinutesSheet([.medium, .large])
                case .conversation:
                    ChatView(viewModel: viewModel.chat)
                        .algoMinutesSheet()
                case .shareExport:
                    ShareExportSheet(
                        note: note,
                        transcript: exportLines(for: note),
                        onExport: { scope, format in
                            viewModel.export(
                                note: note, scope: scope, format: format,
                                transcript: exportLines(for: note), api: env.api
                            ) { env.alertMessage = $0 }
                        },
                        onEmail: { scope, format in
                            viewModel.emailExport(
                                note: note, scope: scope, format: format,
                                transcript: exportLines(for: note), api: env.api
                            ) { env.alertMessage = $0 }
                        },
                        onCreateLink: { scope in
                            viewModel.createShareLink(
                                scope: scope, noteId: note.id, workspaceId: note.workspaceId,
                                api: env.api
                            ) { env.alertMessage = $0 }
                        },
                        mintedLink: viewModel.mintedShareLink,
                        isMintingLink: viewModel.isMintingShareLink
                    )
                    .algoMinutesSheet([.medium, .large])
                }
            }
        }
        .sheet(item: $viewModel.mailDraft) { draft in
            MailComposeSheet(
                subject: draft.subject, body: draft.body, attachment: draft.attachment,
                fileName: draft.fileName, mimeType: draft.mimeType
            ) { viewModel.mailDraft = nil }
        }
        .modifier(OverwriteSummaryDialog(viewModel: viewModel, onConfirm: regenerateConfirmed))
        .confirmationDialog(
            "Delete this note?",
            isPresented: $viewModel.confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { delete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The recording, transcript and summary are removed. This cannot be undone.")
        }
        .alert("AlgoMinutes", isPresented: Binding(
            get: { viewModel.alertMessage != nil },
            set: { if !$0 { viewModel.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.alertMessage ?? "")
        }
    }

    @ViewBuilder
    private func content(_ note: Note) -> some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                NoteHeaderView(
                    title: note.title,
                    createdAt: note.createdAtDate,
                    durationSeconds: note.duration,
                    // Storage metadata, fetched by the player. Absent for
                    // notes with no audio, which NoteMeta collapses around.
                    sizeBytes: env.player.currentNoteId == note.id ? env.player.sizeBytes : nil
                )

                // Offered only when there is audio behind the note — a scan
                // or a PDF has a storagePath, but it points at an image.
                if note.hasPlayableAudio {
                    AudioPlayerCard(note: note)
                }

                switch note.status {
                case .ready:
                    readyContent(note)
                case .error:
                    NoteErrorPane(
                        errorMessage: note.errorMessage,
                        diagnosticCode: note.diagnosticCode
                    ) { retry(note) }
                default:
                    ProcessingPane(
                        stage: NoteProcessingStage.from(
                            status: note.status,
                            progress: note.progress,
                            uploadPercent: env.uploadProgress[note.id]
                        )
                    )
                }
            }
            .padding(20)
        }
        .onChange(of: viewModel.scrollTarget) { _, target in
            guard let target else { return }
            withAnimation { proxy.scrollTo(target, anchor: .top) }
            // One-shot: cleared so the same tile scrolls again next tap.
            viewModel.scrollTarget = nil
        }
        }
    }

    @ViewBuilder
    private func readyContent(_ note: Note) -> some View {
        Picker("View", selection: $viewModel.tab) {
            ForEach(NoteDetailViewModel.Tab.allCases, id: \.self) { tab in
                Text(tab.rawValue).tag(tab)
            }
        }
        .pickerStyle(.segmented)

        // Scoped to this note, so answers cannot drift into other meetings —
        // the difference between this and the workspace chat in Files.
        QuickActionsRow(
            hasActionItems: !(note.summary?.actionItems.isEmpty ?? true),
            canDraft: note.summary != nil,
            onActionItems: {
                viewModel.tab = .summary
                viewModel.scrollTarget = SummaryPane.actionItemsAnchor
            },
            onFollowUp: {
                viewModel.draftFollowUp()
                viewModel.activeSheet = .conversation
            },
            onShare: { viewModel.activeSheet = .shareExport },
            onMore: { viewModel.activeSheet = .moreOperations }
        )

        AskAIComposer(model: viewModel.chat) { viewModel.activeSheet = .conversation }
            .padding(.top, Theme.Spacing.xs)
            .task { viewModel.attachChat(api: env.api, noteId: note.id) }

        switch viewModel.tab {
        case .summary:
            SummaryPane(summary: note.summary)
        case .transcript:
            let lines = env.transcripts.displayLines(mirrored: note.transcript, for: note.id)
            // Follow and seek only while this note is the one loaded in the
            // player — otherwise a tap would scrub whatever else is playing.
            let isLoaded = env.player.currentNoteId == note.id
            TranscriptPane(
                lines: lines,
                rawText: note.rawText,
                activeIndex: isLoaded
                    ? TranscriptTime.activeIndex(in: lines, at: env.player.currentTime)
                    : nil,
                onSeek: note.hasPlayableAudio ? { env.player.seek(to: $0) } : nil,
                // Only call it truncated when the server said so *and* the
                // fetch has not succeeded — otherwise a short note whose
                // mirror is the whole transcript would claim to be clipped.
                isTruncated: note.transcriptTruncated == true
                    && env.transcripts.state == .failed,
                onRetry: { loadFullTranscript(note) }
            )
            .task(id: note.id) { loadFullTranscript(note) }

            // Which notes transcribe badly is a question the corpus cannot
            // answer on its own; this is the only signal that tells us.
            if !lines.isEmpty {
                TranscriptRatingCard(
                    rating: viewModel.rating,
                    isSaving: viewModel.isSavingRating
                ) { stars in
                    guard let workspaceId = env.auth.workspaceId else { return }
                    viewModel.rate(stars, noteId: note.id, workspaceId: workspaceId, api: env.api) {
                        env.alertMessage = $0
                    }
                }
                .padding(.top, Theme.Spacing.md)
            }
        }
    }

    /// Page in the rest of the transcript when Firestore only mirrored a
    /// preview. Cheap to call repeatedly — the repository ignores a request
    /// for a note it has already loaded or is already loading.
    private func loadFullTranscript(_ note: Note) {
        guard note.transcriptTruncated == true,
              let workspaceId = env.auth.workspaceId else { return }
        env.transcripts.loadFull(noteId: note.id, workspaceId: workspaceId)
    }

    /// Lines an export should carry: the full transcript when it has been
    /// fetched, the mirrored preview otherwise — so the file matches what the
    /// user is looking at rather than silently exporting less.
    private func exportLines(for note: Note) -> [TranscriptLine] {
        env.transcripts.displayLines(mirrored: note.transcript, for: note.id)
    }

    /// Copy the note as plain text — the same payload the share sheet sends.
    private func copy(_ note: Note) {
        guard let text = note.shareText else {
            env.alertMessage = "There's nothing to copy yet."
            return
        }
        UIPasteboard.general.string = text
    }

    /// The user agreed to lose their hand-edited summary. Same shape as
    /// `delete()`: works off `noteId` rather than the computed optional note.
    private func regenerateConfirmed(_ prompt: NoteDetailViewModel.OverwritePrompt) {
        guard let workspaceId = note?.workspaceId else { return }
        viewModel.regenerate(
            prompt.template, noteId: noteId, workspaceId: workspaceId,
            api: env.api, confirmOverwrite: true
        ) { env.alertMessage = $0 }
    }

    private func delete() {
        // Stop playback first: the audio is about to be removed from Storage,
        // and an AVPlayer streaming a deleted object fails with a network
        // error rather than stopping cleanly.
        if env.player.currentNoteId == noteId { env.player.stop() }
        env.notes.deleteNote(id: noteId)
        dismiss()
    }

    private func retry(_ note: Note) {
        Task {
            let outcome = await env.retry(note: note)
            if case .blocked(let message) = outcome {
                viewModel.alertMessage = message
            }
        }
    }
}

/// Confirmation before a regenerate discards a hand-edited summary.
///
/// Its own modifier rather than another `.confirmationDialog` inline:
/// `NoteDetailView.body` is the busiest in the app and adding this to it
/// pushed the type-checker past its limit.
private struct OverwriteSummaryDialog: ViewModifier {
    @Bindable var viewModel: NoteDetailViewModel
    let onConfirm: (NoteDetailViewModel.OverwritePrompt) -> Void

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Replace your edited summary?",
            isPresented: Binding(
                get: { viewModel.overwritePrompt != nil },
                set: { if !$0 { viewModel.overwritePrompt = nil } }
            ),
            titleVisibility: .visible,
            presenting: viewModel.overwritePrompt
        ) { prompt in
            Button("Replace", role: .destructive) { onConfirm(prompt) }
            Button("Keep my version", role: .cancel) {}
        } message: { _ in
            Text("You edited this summary. Rewriting it discards your changes.")
        }
    }
}
