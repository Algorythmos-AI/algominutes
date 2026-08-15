import SwiftUI
import UIKit  // UIPasteboard for the copy-link action

/// Share & Export.
///
/// The link row arrived with its backend and with the Privacy/Terms copy that
/// ADR 0004 requires to ship first — it is the app's only unauthenticated
/// egress of recorded content, so the order mattered.
///
/// The sheet says what a link actually is before minting one. Someone tapping
/// "Create link" should not have to open the Privacy Policy to learn that
/// anyone holding it can read the note.
struct ShareExportSheet: View {
    let note: Note
    /// Lines to export. The caller passes whatever is on screen — the full
    /// transcript when it has been fetched, the mirrored preview otherwise —
    /// so the export matches what the user is looking at.
    let transcript: [TranscriptLine]
    let onExport: (ExportScope, ExportFormat) -> Void
    let onEmail: (ExportScope, ExportFormat) -> Void
    /// Mint a link for the chosen scope. Nil hides the row entirely, which is
    /// how a note with nothing shareable avoids offering it.
    var onCreateLink: ((ExportScope) -> Void)?
    /// The most recently minted link, held by the caller so it survives this
    /// sheet being dismissed and reopened.
    var mintedLink: String?
    var isMintingLink: Bool = false

    @Environment(\.dismiss) private var dismiss
    @State private var scope: ExportScope = .both

    private var scopes: [ExportScope] {
        ExportScope.available(for: note, hasTranscript: !transcript.isEmpty)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                Text("Share & Export")
                    .font(Typography.heading(20, weight: .bold))
                    .foregroundStyle(Theme.heading)

                if scopes.isEmpty {
                    Text("This note has nothing to export yet.")
                        .font(Typography.body(14))
                        .foregroundStyle(Theme.muted)
                } else {
                    scopePicker
                    formatRows
                    emailRow
                    if onCreateLink != nil { shareLinkSection }
                    disclosure
                }
            }
            .padding(Theme.Spacing.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.surface)
        .onAppear { if !scopes.contains(scope) { scope = scopes.first ?? .summary } }
    }

    private var scopePicker: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Include".uppercased())
                .font(Typography.label(11))
                .kerning(1.2)
                .foregroundStyle(Theme.muted)
            Picker("Include", selection: $scope) {
                ForEach(scopes) { s in Text(s.label).tag(s) }
            }
            .pickerStyle(.segmented)
        }
    }

    private var formatRows: some View {
        VStack(spacing: 0) {
            ForEach(ExportFormat.allCases) { format in
                Button {
                    dismiss()
                    onExport(scope, format)
                } label: {
                    HStack {
                        Text("Export to \(format.label)")
                            .font(Typography.body(15))
                            .foregroundStyle(Theme.heading)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.tertiary)
                    }
                    .padding(Theme.Spacing.lg)
                }
                .buttonStyle(CardButtonStyle())
                if format != ExportFormat.allCases.last {
                    Divider().overlay(Theme.borderSoft).padding(.horizontal, Theme.Spacing.lg)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated))
    }

    @ViewBuilder
    private var emailRow: some View {
        // Hidden rather than disabled when no mail account exists: presenting
        // the composer there shows an empty modal with no way out.
        if MailComposeSheet.canSend {
            Button {
                dismiss()
                onEmail(scope, .pdf)
            } label: {
                HStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "envelope")
                    Text("Export files to Email")
                        .font(Typography.body(15))
                    Spacer()
                }
                .foregroundStyle(Theme.heading)
                .padding(Theme.Spacing.lg)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated))
            }
            .buttonStyle(CardButtonStyle())
        }
    }

    private var disclosure: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "info.circle")
                .font(.system(size: 12))
                .foregroundStyle(Theme.tertiary)
                .padding(.top, 1)
            Text(NoteExport.redactionNotice)
                .font(Typography.body(12))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Share link

    @ViewBuilder
    private var shareLinkSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Divider().overlay(Theme.borderSoft)  // matches SettingsView's divider

            Text("Share a link")
                .font(Typography.label(13))
                .foregroundStyle(Theme.heading)

            // Stated before the button, not after. The single most important
            // fact about a share link is that it has no password.
            Text("Anyone with the link can read this note without signing in. "
                 + "It expires in 7 days and you can revoke it at any time. "
                 + "The audio is never shared.")
                .font(Typography.body(12))
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)

            if let mintedLink {
                Text(mintedLink)
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.body)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm).fill(Theme.surfaceElevated)
                    )

                Button {
                    UIPasteboard.general.string = mintedLink
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                        .font(Typography.label(14))
                        .frame(maxWidth: .infinity)
                        .padding(Theme.Spacing.lg)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated)
                        )
                        .foregroundStyle(Theme.heading)
                }
                .buttonStyle(CardButtonStyle())
            } else {
                Button {
                    onCreateLink?(scope)
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        if isMintingLink { ProgressView().controlSize(.small) }
                        Label(isMintingLink ? "Creating…" : "Create link", systemImage: "link")
                            .font(Typography.label(14))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(Theme.Spacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated)
                    )
                    .foregroundStyle(Theme.heading)
                }
                .buttonStyle(CardButtonStyle())
                .disabled(isMintingLink)
            }
        }
    }
}

/// Export formats.
///
/// PDF and TXT render on-device. DOCX renders on the server — there is no
/// credible Swift OOXML writer, and bundling one into the app for a rare
/// action is not worth the binary size. One implementation there serves iOS,
/// web and any future client.
enum ExportFormat: String, CaseIterable, Identifiable, Sendable {
    case pdf, txt, docx

    var id: String { rawValue }
    var label: String { rawValue.uppercased() }
    var ext: String { rawValue }

    /// DOCX is fetched from /api/export-note rather than rendered locally.
    var isServerRendered: Bool { self == .docx }

    var mimeType: String {
        switch self {
        case .pdf: return "application/pdf"
        case .txt: return "text/plain"
        case .docx:
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
    }
}
