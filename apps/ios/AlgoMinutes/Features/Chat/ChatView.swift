import SwiftUI

/// RAG chat with SSE streaming + inline [n] citation chips — parity with
/// `ChatTab.tsx`.
struct ChatView: View {
    @Environment(AppEnvironment.self) private var env
    // Injected by FilesView so the conversation survives sheet dismissal;
    // @State keeps a stable identity across re-presentations.
    @State private var viewModel: ChatViewModel
    @State private var selectedNoteId: String?

    @MainActor
    init(viewModel: ChatViewModel? = nil) {
        _viewModel = State(initialValue: viewModel ?? ChatViewModel())
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if viewModel.messages.isEmpty {
                                EmptyStateView(
                                    icon: "bubble.left.and.text.bubble.right",
                                    message: "I can answer questions across every meeting in your workspace and cite the moments I'm pulling from. Try \"What did we agree to ship next quarter?\""
                                )
                            }
                            ForEach(viewModel.messages) { message in
                                messageView(message)
                                    .id(message.id)
                            }
                        }
                        .padding(20)
                    }
                    .onChange(of: viewModel.messages.last?.content) { _, _ in
                        if let last = viewModel.messages.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }

                inputBar
            }
            .background(OwllBackground())
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(item: $selectedNoteId) { noteId in
                NoteDetailView(noteId: noteId)
            }
            .onAppear { viewModel.attach(api: env.api) }
            .onDisappear { viewModel.cancelStreaming() }
        }
    }

    // MARK: - Message rendering

    @ViewBuilder
    private func messageView(_ message: ChatMessage) -> some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(message.content)
                    .font(Typography.body(15))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(Theme.surfaceElevated)
                    )
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                if message.content.isEmpty && viewModel.isStreaming {
                    Text("…")
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.muted)
                } else {
                    citationText(message)
                }
                if let citations = message.citations, !citations.isEmpty {
                    sourcesList(citations)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Renders the assistant text with [n] tokens as tappable orange chips.
    private func citationText(_ message: ChatMessage) -> some View {
        let segments = ChatViewModel.segments(for: message.content)
        // Flow layout via Text concatenation: chips are rendered inline using
        // AttributedString links, resolved to note navigation on tap.
        var attributed = AttributedString()
        for segment in segments {
            switch segment {
            case .text(let text):
                var part = AttributedString(text)
                part.foregroundColor = Theme.body
                attributed += part
            case .citation(let index):
                var chip = AttributedString("[\(index)]")
                chip.foregroundColor = Theme.heading
                chip.font = .system(size: 14, weight: .bold)
                if let citation = citation(at: index, in: message) {
                    chip.link = URL(string: "algominutes://note/\(citation.noteId)")
                }
                attributed += chip
            }
        }
        return Text(attributed)
            .font(Typography.body(15))
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in
                if url.scheme == "algominutes", url.host == "note" {
                    selectedNoteId = url.lastPathComponent
                    return .handled
                }
                return .systemAction
            })
    }

    private func citation(at oneBasedIndex: Int, in message: ChatMessage) -> SearchHit? {
        guard let citations = message.citations,
              oneBasedIndex >= 1, oneBasedIndex <= citations.count else { return nil }
        return citations[oneBasedIndex - 1]
    }

    private func sourcesList(_ citations: [SearchHit]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SOURCES")
                .font(Typography.label(10))
                .kerning(1.2)
                .foregroundStyle(Theme.tertiary)
            ForEach(Array(citations.enumerated()), id: \.offset) { index, citation in
                Button {
                    selectedNoteId = citation.noteId
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.outline)
                        Text("[\(index + 1)] \(sourceTitle(citation)) · \(formatTimestamp(ms: citation.startMs))")
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 4)
    }

    private func sourceTitle(_ citation: SearchHit) -> String {
        if let local = env.notes.notes.first(where: { $0.id == citation.noteId }) {
            return local.title
        }
        return citation.noteTitle?.isEmpty == false ? citation.noteTitle! : "Untitled note"
    }

    // MARK: - Input

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Ask about your meetings…", text: Binding(
                get: { viewModel.draft },
                set: { viewModel.draft = $0 }
            ), axis: .vertical)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                .lineLimit(1...4)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Theme.surfaceElevated)
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.borderSoft))
                )

            Button {
                viewModel.send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? Theme.heading : Theme.tertiary)
            }
            .disabled(!canSend)
            // 44pt hit target (tokens a11y.minTouchTargetPx) — the glyph is 32pt.
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.background.opacity(0.92))
    }

    private var canSend: Bool {
        !viewModel.isStreaming && !viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - View model

@Observable
@MainActor
final class ChatViewModel {
    var messages: [ChatMessage] = []
    var draft = ""
    private(set) var isStreaming = false

    private var api: APIClient?
    private var streamTask: Task<Void, Never>?
    /// When set, retrieval is scoped to this note. The workspace-wide chat
    /// leaves it nil.
    private var noteId: String?

    func attach(api: APIClient, noteId: String? = nil) {
        self.api = api
        self.noteId = noteId
    }

    func send() {
        let query = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, !isStreaming, let api else { return }
        draft = ""

        messages.append(ChatMessage(role: .user, content: query))
        var assistant = ChatMessage(role: .assistant, content: "")
        messages.append(assistant)
        let assistantIndex = messages.count - 1
        isStreaming = true

        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in api.chatStream(query: query, noteId: noteId) {
                    switch event {
                    case .citations(let hits):
                        assistant.citations = hits
                    case .textDelta(let text):
                        assistant.content += text
                    case .serverError(let error):
                        assistant.content += "\n\n_Error: \(error)_"
                    case .done:
                        break
                    }
                    self.messages[assistantIndex] = assistant
                }
            } catch is CancellationError {
                // view left — keep partial answer
            } catch {
                let message = (error as? APIError)?.errorDescription ?? error.localizedDescription
                assistant.content += assistant.content.isEmpty
                    ? "Error: \(message)"
                    : "\n\nError: \(message)"
                self.messages[assistantIndex] = assistant
            }
            self.isStreaming = false
        }
    }

    func cancelStreaming() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    // MARK: - Citation token splitting (parity with /(\[\d+\])/g)

    enum Segment: Equatable {
        case text(String)
        case citation(Int)
    }

    static func segments(for content: String) -> [Segment] {
        var segments: [Segment] = []
        var remaining = Substring(content)
        while let range = remaining.range(of: #"\[\d+\]"#, options: .regularExpression) {
            if range.lowerBound > remaining.startIndex {
                segments.append(.text(String(remaining[..<range.lowerBound])))
            }
            let token = remaining[range]
            let digits = token.dropFirst().dropLast()
            if let n = Int(digits) {
                segments.append(.citation(n))
            } else {
                segments.append(.text(String(token)))
            }
            remaining = remaining[range.upperBound...]
        }
        if !remaining.isEmpty {
            segments.append(.text(String(remaining)))
        }
        return segments
    }
}
