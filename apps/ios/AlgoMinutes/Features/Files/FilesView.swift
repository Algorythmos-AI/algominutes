import SwiftUI

/// Owll-style Files tab: every note in the workspace behind a search bar,
/// source filter chips, and an "Ask AI" entry into chat. Replaces the old
/// Search tab (transcript search lives behind the same search field) and
/// the AllNotes screen.
struct FilesView: View {
    @Environment(AppEnvironment.self) private var env

    @State private var query = ""
    @State private var filter: SourceFilter = .all
    @State private var selectedNoteId: String?
    @State private var showChat = false
    // Owned here (not by ChatView) so the conversation survives sheet dismissal.
    @State private var chatModel = ChatViewModel()

    // Transcript search (submit-driven, same backend as the old Search tab).
    @State private var transcriptHits: [SearchHit] = []
    @State private var isSearching = false
    @State private var searchError: String?

    enum SourceFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case voiceNote = "Voice Note"
        case imported = "Imported"
        case scanned = "Scanned"

        var id: String { rawValue }

        func matches(_ note: Note) -> Bool {
            switch self {
            case .all: return true
            // Legacy docs carry online_meeting; they are mic captures too.
            case .voiceNote: return note.type == .recording || note.type == .onlineMeeting
            case .imported: return [.importAudio, .importPdf, .youtube].contains(note.type)
            case .scanned: return note.type == .scanText
            }
        }
    }

    private var filteredNotes: [Note] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return env.notes.notes.filter { note in
            guard filter.matches(note) else { return false }
            guard !trimmed.isEmpty else { return true }
            return note.title.localizedCaseInsensitiveContains(trimmed)
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchBar
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.top, Theme.Spacing.sm)
                filterChips
                    .padding(.top, Theme.Spacing.md)
                notesList
            }
            .background(OwllBackground())
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(item: $selectedNoteId) { noteId in
                NoteDetailView(noteId: noteId)
            }
        }
        .sheet(isPresented: $showChat) {
            ChatView(viewModel: chatModel)
                .algoMinutesSheet()
        }
    }

    // MARK: - Search bar with Ask AI pill

    private var searchBar: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.tertiary)
            TextField("Search your files", text: $query)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .submitLabel(.search)
                .onSubmit { Task { await runTranscriptSearch() } }
                .onChange(of: query) { _, newValue in
                    // Title filtering is live; transcript hits only refresh on
                    // submit, and clear once the query is gone.
                    if newValue.isEmpty { transcriptHits = []; searchError = nil }
                }
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.tertiary)
                        // 44pt hit target (tokens a11y.minTouchTargetPx) — the glyph alone is ~17pt.
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Clear search")
            }
            Button {
                showChat = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Ask AI")
                        .font(Typography.label(13))
                }
                .foregroundStyle(Theme.heading)
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 7)
                .background(
                    Capsule().strokeBorder(Theme.outline.opacity(0.5), lineWidth: 1)
                )
            }
            .accessibilityLabel("Ask AI about your meetings")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .fill(Theme.surface)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.borderSoft))
        )
    }

    // MARK: - Filter chips

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(SourceFilter.allCases) { item in
                    Button {
                        filter = item
                    } label: {
                        Text(item.rawValue)
                            .font(Typography.label(13))
                            .foregroundStyle(filter == item ? Theme.onInverse : Theme.outline)
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.vertical, 7)
                            .background(
                                Capsule().fill(filter == item ? Theme.inverse : .clear)
                                    .overlay(
                                        Capsule().strokeBorder(
                                            filter == item ? .clear : Theme.outline.opacity(0.4),
                                            lineWidth: 1
                                        )
                                    )
                            )
                    }
                    .sensoryFeedback(.selection, trigger: filter)
                    .accessibilityAddTraits(filter == item ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, Theme.Spacing.xl)
        }
    }

    // MARK: - Notes list

    private var notesList: some View {
        List {
            if let error = searchError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.heading)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if filteredNotes.isEmpty && transcriptHits.isEmpty && !isSearching {
                EmptyStateView(
                    icon: query.isEmpty ? "folder" : "magnifyingglass",
                    message: query.isEmpty
                        ? "Nothing here yet — capture or import your first meeting from Home."
                        : "No files match that search."
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            ForEach(filteredNotes) { note in
                Button {
                    selectedNoteId = note.id
                } label: {
                    fileCard(note)
                }
                .buttonStyle(CardButtonStyle())
                .listRowInsets(EdgeInsets(
                    top: 6, leading: Theme.Spacing.xl, bottom: 6, trailing: Theme.Spacing.xl
                ))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .contextMenu { NoteContextMenu(note: note, selectedNoteId: $selectedNoteId) }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        let id = note.id
                        Task {
                            do { try await env.notes.deleteNote(id: id) }
                            catch { env.alertMessage = "Couldn't delete this note. Please try again." }
                        }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    // Monochrome: override the system-red destructive tint.
                    .tint(Theme.surfaceElevated)
                }
                .swipeActions(edge: .leading) {
                    if note.status == .ready, let text = note.shareText {
                        ShareLink(item: text) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                        .tint(Theme.tertiary)
                    }
                }
            }

            if isSearching {
                ProgressView("Searching transcripts…")
                    .tint(Theme.outline)
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if !transcriptHits.isEmpty {
                Section {
                    ForEach(transcriptHits) { hit in
                        Button {
                            selectedNoteId = hit.noteId
                        } label: {
                            transcriptHitCard(hit)
                        }
                        .buttonStyle(CardButtonStyle())
                        .listRowInsets(EdgeInsets(
                            top: 6, leading: Theme.Spacing.xl, bottom: 6, trailing: Theme.Spacing.xl
                        ))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                } header: {
                    Text("MATCHES IN TRANSCRIPTS")
                        .font(Typography.eyebrow())
                        .tracking(1.4)
                        .foregroundStyle(Theme.muted)
                        .padding(.leading, Theme.Spacing.xl)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await env.notes.refresh() }
    }

    // MARK: - Cards

    private func fileCard(_ note: Note) -> some View {
        OwllCard(style: .flat) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: iconName(for: note.type))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.outline)
                    if let created = note.createdAtDate {
                        Text(created.formatted(.dateTime.month(.twoDigits).day(.twoDigits)) + " " +
                             created.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute()))
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                    }
                    if let duration = note.duration, duration > 0 {
                        Text("· \(formatTimer(seconds: Int(duration)))")
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                    }
                    Spacer()
                }
                Text(note.title)
                    .font(Typography.headline())
                    .foregroundStyle(Theme.heading)
                    .lineLimit(2)
                summaryOrStatus(note)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func summaryOrStatus(_ note: Note) -> some View {
        switch note.status {
        case .ready:
            if let gist = note.summary?.gist, !gist.isEmpty {
                Text(gist)
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
        case .error:
            Label(note.errorMessage ?? "Processing failed", systemImage: "exclamationmark.triangle.fill")
                .font(Typography.body(12))
                .foregroundStyle(Theme.heading)
                .lineLimit(1)
        default:
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(Theme.outline)
                Capsule()
                    .fill(Color.white.opacity(0.06))
                    .frame(width: 140, height: 6)
                    .shimmer()
            }
        }
    }

    private func transcriptHitCard(_ hit: SearchHit) -> some View {
        OwllCard(style: .flat) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack {
                    Label(noteTitle(for: hit), systemImage: "doc.text")
                        .font(Typography.heading(14, weight: .bold))
                        .foregroundStyle(Theme.heading)
                        .lineLimit(1)
                    Spacer()
                    Text(formatTimestamp(ms: hit.startMs))
                        .font(Typography.body(11))
                        .foregroundStyle(Theme.tertiary)
                }
                Text(truncatedChunk(hit.chunkText))
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.body)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Helpers

    private func iconName(for type: NoteType) -> String {
        switch type {
        case .recording, .onlineMeeting: return "waveform"
        case .importAudio: return "waveform.badge.plus"
        case .importPdf: return "doc.richtext"
        case .youtube: return "play.rectangle"
        case .scanText: return "doc.text.viewfinder"
        }
    }

    private func noteTitle(for hit: SearchHit) -> String {
        if let local = env.notes.notes.first(where: { $0.id == hit.noteId }) {
            return local.title
        }
        if let title = hit.noteTitle, !title.isEmpty {
            return title
        }
        return "Untitled note"
    }

    private func truncatedChunk(_ text: String) -> String {
        text.count > 240 ? String(text.prefix(240)) + "…" : text
    }

    private func runTranscriptSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSearching = true
        searchError = nil
        defer { isSearching = false }
        do {
            transcriptHits = try await env.api.search(query: trimmed, k: 12)
        } catch {
            transcriptHits = []
            searchError = (error as? APIError)?.errorDescription ?? "Search failed"
        }
    }
}
