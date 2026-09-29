import Observation
import SwiftUI

/// Send the notetaker to a Google Meet from a pasted link (RELEASE.md PR 25;
/// docs/plans/MEETINGS.md; docs/CONSENT.md §2.4), as the web's /notetaker does.
/// Offered only while `/v1/config` has it on for this user (AppSwitches).
/// The create contract has no consent field, so this sheet enforces the
/// affirmation: nothing is sent until it's ticked, every time.
enum NotetakerLink {
    /// CONSENT.md §2.4's affirmation, word for word (the same as recording, §2.2).
    static let affirmation = "I have permission from anyone whose voice may be captured. If others are present, I'll let them know the meeting is being recorded."

    /// A Google Meet link as someone would paste it (with or without https://),
    /// normalised; nil if it isn't one.
    static func meetingURL(from raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        var withScheme = s
        if s.lowercased().hasPrefix("http://") { withScheme = "https://" + s.dropFirst("http://".count) }
        else if !s.lowercased().hasPrefix("https://") { withScheme = "https://" + s }
        guard let url = URL(string: withScheme), url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "meet.google.com", url.user == nil, url.port == nil
        else { return nil }
        let code = url.path.split(separator: "/").first.map(String.init) ?? ""
        guard code.range(of: "^[a-zA-Z]{3}-[a-zA-Z]{4}-[a-zA-Z]{3}$", options: .regularExpression) != nil else { return nil }
        return withScheme
    }
}

@MainActor
@Observable
final class SendNotetakerModel {
    var link = ""
    var title = ""
    var agreed = false
    private(set) var busy = false
    private(set) var error: String?
    /// One request id per meeting sent: a retry after a dropped answer returns
    /// the same notetaker, never a second.
    @ObservationIgnored private var request: (link: String, id: String)?
    @ObservationIgnored private let makeId: () -> String

    init(makeId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.makeId = makeId
    }

    var meetingURL: String? { NotetakerLink.meetingURL(from: link) }
    var linkIsWrong: Bool { !link.trimmingCharacters(in: .whitespaces).isEmpty && meetingURL == nil }
    var canSend: Bool { meetingURL != nil && agreed && !busy }

    /// Send it; the note to open, or nil (the error says why).
    func send(create: (String, String?, String) async throws -> APIClient.MeetingBotResult) async -> String? {
        guard canSend, let meetingURL else { return nil }
        busy = true
        error = nil
        defer { busy = false }
        if request?.link != meetingURL { request = (meetingURL, makeId()) }
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        do {
            switch try await create(meetingURL, trimmed.isEmpty ? nil : trimmed, request!.id) {
            case .sent(_, let noteId), .alreadyOnItsWay(let noteId):
                return noteId
            }
        } catch let err as APIError {
            if case .http(_, let message?) = err, message.contains(" ") { error = message }
            else { error = "The notetaker wasn't sent. Please try again." }
        } catch {
            AppLog.error("notetaker_send_failed: \(error.localizedDescription)")
            self.error = "The notetaker wasn't sent. Check your connection and try again."
        }
        return nil
    }
}

struct SendNotetakerSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    /// Opens the note once it's sent (or the one already on its way).
    let onSent: (String) -> Void
    @State private var model = SendNotetakerModel()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://meet.google.com/abc-defg-hij", text: $model.link)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if model.linkIsWrong {
                        Text("Paste a Google Meet link, like https://meet.google.com/abc-defg-hij.")
                            .font(Typography.body(13))
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Meeting link")
                } footer: {
                    Text("It joins as your notetaker, posts a notice to everyone, and leaves a note with who said what.")
                }
                Section {
                    TextField("Title (optional)", text: $model.title)
                }
                Section {
                    ConsentCheckbox(isChecked: $model.agreed, text: NotetakerLink.affirmation)
                } footer: {
                    Text("The meeting's audio is processed by Recall.ai in Tokyo, then deleted there once your note has it.")
                }
                if let error = model.error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button(model.busy ? "Sending…" : "Send the notetaker") {
                        Task {
                            let api = env.api
                            if let noteId = await model.send(create: { try await api.createMeetingBot(meetingUrl: $0, title: $1, requestId: $2) }) {
                                dismiss()
                                onSent(noteId)
                            }
                        }
                    }
                    .disabled(!model.canSend)
                }
            }
            .navigationTitle("Send the notetaker")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
