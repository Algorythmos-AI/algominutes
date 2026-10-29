import SwiftUI

/// The agreement to send recordings and their text to Google Cloud AI (App Store guideline 5.1.2(i)), asked once
/// per device before the first upload from any path (`AISharingPath`). "Not now", or closing the sheet, sends
/// nothing and leaves the user where they were.
struct AISharingConsentSheet: View {
    let onAgree: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(AISharingCopy.title)
                        .font(Typography.heading(22, weight: .bold))
                        .foregroundStyle(Theme.heading)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("aiSharing.title")
                    Text(AISharingCopy.body)
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("aiSharing.body")
                    Text(AISharingCopy.detail)
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                    Link("Privacy Policy", destination: LegalLinks.privacy)
                        .font(Typography.body(14))
                        .accessibilityIdentifier("aiSharing.privacy")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            // Pinned under the words, so both are on screen at any text size.
            VStack(spacing: 10) {
                Button(AISharingCopy.agree, action: onAgree)
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("aiSharing.agree")
                Button(AISharingCopy.notNow, action: onNotNow)
                    .buttonStyle(SecondaryButtonStyle())
                    .accessibilityIdentifier("aiSharing.notNow")
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface)
    }
}

/// Presents the agreement for a waiting `AISharingRequest`, and runs it once agreed: after the sheet has gone,
/// so whatever it opens next (the recorder, a picker) isn't presented over a sheet that's still closing.
private struct AISharingGateModifier: ViewModifier {
    @Binding var request: AISharingRequest?
    let consent: AISharingConsent
    @State private var approved: AISharingRequest?
    @State private var shown: AISharingRequest?

    func body(content: Content) -> some View {
        content.sheet(item: $request, onDismiss: {
            if let approved {
                self.approved = nil
                approved.proceed()
            } else if let shown {
                // "Not now", or swiped away: nothing is sent, and the user stays where they were.
                AppLog.info("ai_sharing_declined path=\(shown.path.rawValue)")
            }
            shown = nil
        }) { waiting in
            AISharingConsentSheet(
                onAgree: {
                    consent.agree()
                    approved = waiting
                    request = nil
                },
                onNotNow: { request = nil }
            )
            .onAppear { shown = waiting }
            .algoMinutesSheet([.medium, .large])
        }
    }
}

extension View {
    /// Shows the Google Cloud AI agreement whenever `request` is set (by `AISharingConsent.gate`).
    @MainActor
    func aiSharingGate(_ request: Binding<AISharingRequest?>, consent: AISharingConsent) -> some View {
        modifier(AISharingGateModifier(request: request, consent: consent))
    }
}

/// Settings: whether recordings are sent to Google Cloud AI, and the way to stop it (or start again).
struct AISharingSettingsCard: View {
    @Environment(AppEnvironment.self) private var env
    @State private var confirmingWithdraw = false
    @State private var request: AISharingRequest?

    var body: some View {
        let agreed = env.aiSharing.isAgreed
        AlgoMinutesCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(AISharingCopy.settingsTitle)
                        .font(Typography.body(15))
                        .foregroundStyle(Theme.body)
                    Spacer()
                    Button(agreed ? AISharingCopy.withdraw : AISharingCopy.turnOn) {
                        if agreed {
                            confirmingWithdraw = true
                        } else {
                            request = env.aiSharing.gate(.pendingUploads) {
                                // Recordings that waited on this iPhone go now.
                                Task { await env.resumePendingUploads() }
                            }
                        }
                    }
                    .font(Typography.body(14))
                    .accessibilityIdentifier(agreed ? "settings.aiSharing.withdraw" : "settings.aiSharing.agree")
                }
                Text(agreed ? AISharingCopy.settingsOn : AISharingCopy.settingsOff)
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(agreed ? "settings.aiSharing.on" : "settings.aiSharing.off")
            }
        }
        .confirmationDialog(AISharingCopy.withdrawTitle, isPresented: $confirmingWithdraw, titleVisibility: .visible) {
            Button(AISharingCopy.withdrawConfirm, role: .destructive) { env.aiSharing.withdraw() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(AISharingCopy.withdrawMessage)
        }
        .aiSharingGate($request, consent: env.aiSharing)
    }
}
