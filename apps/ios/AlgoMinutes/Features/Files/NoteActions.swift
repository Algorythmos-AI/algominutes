import SwiftUI

// Note actions shared across the Files tab and (soon) note detail: the
// plain-text share payload and the context menu.
//
// This file also held a NoteRowView, a second row design that nothing ever
// referenced — FilesView renders its own fileCard. Two divergent row layouts
// were being maintained and only one was reachable, so the dead one is gone.

extension Note {
    /// Plain-text export used by Share actions. Nil until a summary exists.
    var shareText: String? {
        guard let summary else { return nil }
        var parts = [title, "", summary.gist]
        if !summary.actionItems.isEmpty {
            parts.append("")
            parts.append("Action items:")
            parts.append(contentsOf: summary.actionItems.map { "• \($0)" })
        }
        return parts.joined(separator: "\n")
    }
}

struct NoteContextMenu: View {
    @Environment(AppEnvironment.self) private var env
    let note: Note
    @Binding var selectedNoteId: String?

    var body: some View {
        Button {
            selectedNoteId = note.id
        } label: {
            Label("Open", systemImage: "arrow.up.right")
        }
        if note.status == .ready, let text = note.shareText {
            ShareLink(item: text) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
        if note.status == .error {
            Button {
                // Through env.retry, like the note screen: it re-uploads a
                // recording still on disk, and a refusal is shown.
                Task {
                    if case .blocked(let message) = await env.retry(note: note) {
                        env.alertMessage = message
                    }
                }
            } label: {
                Label("Retry processing", systemImage: "arrow.clockwise")
            }
        }
        Divider()
        Button(role: .destructive) {
            let id = note.id
            Task {
                do { try await env.notes.deleteNote(id: id) }
                catch { env.alertMessage = "Couldn't delete this note. Please try again." }
            }
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }
}
