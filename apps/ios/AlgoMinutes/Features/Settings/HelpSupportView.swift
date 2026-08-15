import SwiftUI

/// A10 #4: static Help/FAQ + a "Contact support" action.
///
/// The FAQ is intentionally static (no network) so it works offline and can't
/// become a dead end. "Contact support" opens a composer that attaches only
/// diagnostic context — app version, device, and an optional note reference —
/// and NEVER audio or transcript content.
struct HelpSupportView: View {
    /// A note the user was looking at when they opened support, if any. Attached
    /// as a reference only (id), so the team can find the server-side logs.
    var contextNoteId: String?

    @State private var showComposer = false

    private struct FAQItem: Identifiable {
        let id = UUID()
        let q: String
        let a: String
    }

    private let faqs: [FAQItem] = [
        .init(
            q: "How do I record a meeting?",
            a: "Tap Record on the Home tab. You'll see a short notice about recording consent, then tap Start. Recording never begins on its own."
        ),
        .init(
            q: "Where do my recordings go?",
            a: "Audio is uploaded to your AlgoMinutes account to be transcribed and summarised, then kept there until you delete it. The on-device copy is removed once the upload is confirmed."
        ),
        .init(
            q: "Is it legal to record?",
            a: "Recording laws vary by location and it is your responsibility to have everyone's consent. AlgoMinutes shows a reminder before every recording but does not provide legal advice."
        ),
        .init(
            q: "How long are my notes kept?",
            a: "By default until you delete them. You can set an automatic retention window in Settings under Data retention."
        ),
        .init(
            q: "The transcript looks wrong. What can I do?",
            a: "Open the note, go to Transcriptions, and use “Report a problem with this transcript”. That sends us the note reference (never the audio) so we can look into it."
        ),
        .init(
            q: "How do I delete my account?",
            a: "Settings → Delete my account. This permanently removes your recordings, transcripts, summaries, and account."
        ),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                OwllCard {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(faqs.enumerated()), id: \.element.id) { index, item in
                            if index > 0 { Divider().overlay(Theme.borderSoft) }
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.q)
                                    .font(Typography.heading(15, weight: .bold))
                                    .foregroundStyle(Theme.heading)
                                Text(item.a)
                                    .font(Typography.body(14))
                                    .foregroundStyle(Theme.body)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }

                Button {
                    showComposer = true
                } label: {
                    Label("Contact support", systemImage: "envelope")
                        .font(Typography.label(15))
                        .foregroundStyle(Theme.onInverse)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.inverse))
                }

                Text("We only receive your message, app version, device model, and — if you opened this from a note — that note's reference. Never your audio or transcript.")
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(20)
        }
        .background(OwllBackground())
        .navigationTitle("Help & Support")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showComposer) {
            SupportComposerView(kind: .contact, noteId: contextNoteId)
                .algoMinutesSheet([.medium, .large])
        }
    }
}

/// A10 #4: composes a support request and posts it via `APIClient.submitSupport`.
/// Diagnostic context only — the body carries the typed message plus app
/// version, device model, and an optional note reference.
struct SupportComposerView: View {
    let kind: APIClient.SupportKind
    var noteId: String?

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    @State private var message = ""
    @State private var isSending = false
    @State private var didSend = false
    @State private var errorMessage: String?

    private var title: String {
        switch kind {
        case .contact: return "Contact support"
        case .badTranscript: return "Report a bad transcript"
        case .badSummary: return "Report a bad summary"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title)
                .font(Typography.heading(20, weight: .bold))
                .foregroundStyle(Theme.heading)

            if didSend {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Thanks — we've got it", systemImage: "checkmark.circle.fill")
                        .font(Typography.heading(16, weight: .bold))
                        .foregroundStyle(Theme.heading)
                    Text("Our team will take a look. We don't have access to your audio or transcript — just the details you sent.")
                        .font(Typography.body(14))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Done") { dismiss() }
                        .buttonStyle(PrimaryButtonStyle())
                }
            } else {
                Text("Tell us what's going on. Please don't include anything sensitive — we can't see your recordings.")
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.body)
                    .fixedSize(horizontal: false, vertical: true)

                TextEditor(text: $message)
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Theme.card)
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.borderSoft))
                    )

                Text("Attached: app \(DeviceInfo.appVersion) · \(DeviceInfo.deviceDescription)\(noteId != nil ? " · note ref" : "")")
                    .font(Typography.body(11))
                    .foregroundStyle(Theme.tertiary)

                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.heading)
                }

                Spacer()

                Button {
                    Task { await send() }
                } label: {
                    HStack {
                        if isSending { ProgressView().tint(.white) }
                        Text(isSending ? "Sending…" : "Send")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Cancel") { dismiss() }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(isSending)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface)
    }

    private func send() async {
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            try await env.api.submitSupport(
                kind: kind,
                message: message,
                noteId: noteId,
                appVersion: DeviceInfo.appVersion,
                device: DeviceInfo.deviceDescription
            )
            didSend = true
        } catch {
            AppLog.error("support_submit_failed: \(error.localizedDescription)")
            errorMessage = "Couldn't send that just now. Please try again."
        }
    }
}
