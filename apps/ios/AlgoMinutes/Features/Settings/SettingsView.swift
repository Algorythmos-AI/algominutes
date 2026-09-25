import SwiftUI

/// Parity with the Settings tab in `src/App.tsx`.
struct SettingsView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var showDeleteSheet = false
    @State private var confirmingSignOut = false
    // A7.2 (P1) stub: read by BackgroundUploadService via UploadPreferences.
    @AppStorage(UploadPreferences.wifiOnlyKey) private var wifiOnlyUploads = false

    private static let adminEmails: Set<String> = ["skalaliya@gmail.com"]

    private var isAdmin: Bool {
        guard let email = env.auth.user?.email?.lowercased() else { return false }
        return Self.adminEmails.contains(email)
    }

    // Real client-side usage — no quotas, no paywall. Minutes counts ready
    // notes created in the current calendar month.
    private var minutesThisMonth: Int {
        let calendar = Calendar.current
        let seconds = env.notes.notes
            .filter { note in
                guard note.status == .ready, let created = note.createdAtDate else { return false }
                return calendar.isDate(created, equalTo: .now, toGranularity: .month)
            }
            .compactMap(\.duration)
            .reduce(0, +)
        return Int(seconds / 60)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    usageCard

                    subscriptionCard

                    OwllCard {
                        VStack(alignment: .leading, spacing: 14) {
                            Link(destination: LegalLinks.webApp) {
                                linkRow(label: "Web version", icon: "macbook")
                            }
                        }
                    }

                    // A7.2 (P1): Wi-Fi-only uploads. The uploader reads this via
                    // UploadPreferences.wifiOnly at session creation.
                    OwllCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Toggle(isOn: $wifiOnlyUploads) {
                                Text("Upload on Wi-Fi only")
                                    .font(Typography.body(15))
                                    .foregroundStyle(Theme.body)
                            }
                            .tint(Theme.heading)
                            Text("When on, recordings wait for Wi-Fi instead of using cellular data.")
                                .font(Typography.body(12))
                                .foregroundStyle(Theme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    // A10 #5: automatic note-retention window.
                    RetentionSettingsCard()

                    // A10 #4: static FAQ + contact support.
                    OwllCard {
                        NavigationLink {
                            HelpSupportView()
                        } label: {
                            linkRow(label: "Help & Support", icon: "questionmark.circle")
                        }
                    }

                    OwllCard {
                        VStack(alignment: .leading, spacing: 14) {
                            infoRow(label: "Account", value: env.auth.user?.email ?? "—")
                            Divider().overlay(Theme.borderSoft)
                            infoRow(label: "Workspace ID", value: env.auth.workspaceId ?? "—")
                        }
                    }

                    OwllCard {
                        VStack(alignment: .leading, spacing: 14) {
                            Link(destination: LegalLinks.privacy) {
                                linkRow(label: "Privacy Policy")
                            }
                            Divider().overlay(Theme.borderSoft)
                            Link(destination: LegalLinks.terms) {
                                linkRow(label: "Terms of Service")
                            }
                            Divider().overlay(Theme.borderSoft)
                            HStack {
                                Text("About AlgoMinutes")
                                    .font(Typography.body(15))
                                    .foregroundStyle(Theme.body)
                                Spacer()
                                Text(appVersion)
                                    .font(Typography.body(13))
                                    .foregroundStyle(Theme.tertiary)
                            }
                        }
                    }

                    if isAdmin {
                        AdminCostsCard()
                    }

                    Button {
                        // Signing out wipes on-device recordings for privacy on
                        // a shared device. Ask first when that would destroy a
                        // recording the user has not got back yet — losing a
                        // recording to a routine sign-out is not recoverable.
                        if env.pendingRecordingsAtRisk > 0 {
                            confirmingSignOut = true
                        } else {
                            env.signOut()
                        }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(Typography.label(15))
                            .foregroundStyle(Theme.body)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(
                                RoundedRectangle(cornerRadius: 16)
                                    .fill(Theme.surface)
                                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border))
                            )
                    }

                    Button {
                        showDeleteSheet = true
                    } label: {
                        Label("Delete my account", systemImage: "trash")
                            .font(Typography.label(15))
                            .foregroundStyle(Theme.heading)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.tertiary))
                    }
                }
                .padding(20)
            }
            .background(OwllBackground())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .confirmationDialog(
            "Sign out and delete unsent recordings?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out and delete", role: .destructive) { env.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(env.pendingRecordingsAtRisk == 1
                 ? "One recording hasn't finished uploading. Signing out removes it from this device and it can't be recovered."
                 : "\(env.pendingRecordingsAtRisk) recordings haven't finished uploading. Signing out removes them from this device and they can't be recovered.")
        }
        .sheet(isPresented: $showDeleteSheet) {
                DeleteAccountSheet()
                    .algoMinutesSheet([.medium, .large])
            }
        }
    }

    // MARK: - Usage (Owll-style meters, real numbers only)

    private var usageCard: some View {
        OwllCard(style: .raised) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text("THIS MONTH")
                    .font(Typography.eyebrow())
                    .tracking(1.4)
                    .foregroundStyle(Theme.muted)
                HStack(spacing: Theme.Spacing.xxl) {
                    usageStat(value: "\(minutesThisMonth)", unit: "min", label: "Transcribed")
                    Divider().overlay(Theme.borderSoft).frame(height: 40)
                    usageStat(value: "\(env.notes.notes.count)", unit: "", label: "Notes")
                }
            }
        }
    }

    /// Subscription status + entry points. The Restore button lives here (and on
    /// the paywall) so it is always reachable, including for a guest who has not
    /// created a permanent account — an App Review requirement.
    @ViewBuilder
    private var subscriptionCard: some View {
        OwllCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("PLAN")
                            .font(Typography.eyebrow())
                            .tracking(1.4)
                            .foregroundStyle(Theme.muted)
                        Text(planLabel)
                            .font(Typography.headline())
                            .foregroundStyle(Theme.heading)
                    }
                    Spacer()
                    if env.billing.entitlement?.state != .active, AppConfig.paywallEnabled {
                        Button("Go Pro") { env.billing.presentPaywall(.manual) }
                            .font(Typography.label(14))
                            .foregroundStyle(Theme.onInverse)
                            .padding(.horizontal, Theme.Spacing.lg)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Theme.inverse))
                    }
                }
                Divider().overlay(Theme.borderSoft)
                Button("Restore Purchases") {
                    Task { await env.billing.store.restore(); await env.billing.refresh() }
                }
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
                if env.billing.entitlement?.state == .active {
                    Divider().overlay(Theme.borderSoft)
                    Button("Manage Subscription") {
                        Task { await env.billing.store.showManageSubscriptions() }
                    }
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                }
            }
        }
    }

    private var planLabel: String {
        switch env.billing.entitlement?.state {
        case .active?: return "Pro"
        case .trialing?:
            if let days = env.billing.trialDaysRemaining {
                return "Free trial · \(days) day\(days == 1 ? "" : "s") left"
            }
            return "Free trial"
        case .expired?, .freeFloor?: return "Free"
        case .none: return "Free"
        }
    }

    private func usageStat(value: String, unit: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(Typography.heading(32))
                    .foregroundStyle(Theme.heading)
                    .monospacedDigit()
                if !unit.isEmpty {
                    Text(unit)
                        .font(Typography.label(14))
                        .foregroundStyle(Theme.muted)
                }
            }
            Text(label)
                .font(Typography.body(12))
                .foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "v\(version) (\(build))"
    }

    private func infoRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased())
                .font(Typography.label(10))
                .kerning(1.2)
                .foregroundStyle(Theme.tertiary)
            Text(value)
                .font(Typography.body(14))
                .foregroundStyle(Theme.body)
        }
    }

    private func linkRow(label: String, icon: String? = nil) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.outline)
            }
            Text(label)
                .font(Typography.body(15))
                .foregroundStyle(Theme.body)
            Spacer()
            Image(systemName: "arrow.up.right")
                .font(.system(size: 12))
                .foregroundStyle(Theme.tertiary)
        }
    }
}

// MARK: - Delete account (parity with DeleteAccountConfirmation.tsx)

struct DeleteAccountSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss

    @State private var acknowledged = false
    @State private var confirmationText = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?
    @State private var revocation = AppleTokenRevocation()

    private var canDelete: Bool {
        acknowledged
            && confirmationText.trimmingCharacters(in: .whitespaces).lowercased() == "delete"
            && !isDeleting
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                Image(systemName: "trash.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.heading)
                Text("Delete your account")
                    .font(Typography.heading(20, weight: .bold))
                    .foregroundStyle(Theme.heading)
            }

            Text("This permanently deletes your account, every recording, every transcript, every summary, and every search index entry. It cannot be undone.")
                .font(Typography.body(14))
                .foregroundStyle(Theme.body)
                .fixedSize(horizontal: false, vertical: true)

            ConsentCheckbox(
                isChecked: $acknowledged,
                text: "I understand this is permanent and I have exported anything I want to keep."
            )

            VStack(alignment: .leading, spacing: 6) {
                Text("Type DELETE to confirm:")
                    .font(Typography.label(13))
                    .foregroundStyle(Theme.muted)
                TextField("DELETE", text: $confirmationText)
                    .font(Typography.body(15))
                    .foregroundStyle(Theme.body)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Theme.card)
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.borderSoft))
                    )
            }

            if let error = errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.heading)
            }

            Spacer()

            Button {
                Task { await deleteAccount() }
            } label: {
                HStack {
                    if isDeleting { ProgressView().tint(.white) }
                    Text(isDeleting ? "Deleting…" : "Delete forever")
                }
                .font(Typography.label(16))
                .foregroundStyle(Theme.onInverse)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.inverse))
            }
            .disabled(!canDelete)
            .opacity(canDelete ? 1 : 0.5)

            Button("Cancel") { dismiss() }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(isDeleting)
        }
        .padding(24)
        .background(Theme.surface)
        .interactiveDismissDisabled(isDeleting)
    }

    private func deleteAccount() async {
        guard canDelete else { return }
        isDeleting = true
        errorMessage = nil
        // Apple first (it requires the revocation, and a deleted account can't
        // be asked again). A dismissed prompt stops the deletion; a failed
        // revocation doesn't, since removing the user's data comes first.
        do {
            if try await revocation.revokeIfLinked() == .cancelled {
                errorMessage = "Deleting an account that uses Sign in with Apple needs Apple's confirmation. Please try again."
                isDeleting = false
                return
            }
        } catch {
            AppLog.error("apple_token_revoke_failed: \(error.localizedDescription)")
        }
        do {
            try await env.api.deleteAccount()
            env.signOut()
            dismiss()
        } catch {
            errorMessage = "Could not delete your account. Please try again or contact support."
            isDeleting = false
        }
    }
}

// MARK: - Admin costs (parity with AdminCostsCard.tsx)

struct AdminCostsCard: View {
    @Environment(AppEnvironment.self) private var env

    private var readyNotes: [Note] {
        env.notes.notes
            .filter { $0.status == .ready }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var last30Total: Double {
        let cutoff = Date().addingTimeInterval(-30 * 24 * 3600)
        return readyNotes
            .filter { ($0.createdAtDate ?? .distantPast) >= cutoff }
            .reduce(0) { $0 + CostModel.estimate(note: $1).total }
    }

    var body: some View {
        OwllCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Admin tools")
                        .font(Typography.heading(16, weight: .bold))
                        .foregroundStyle(Theme.heading)
                    Text("ADMIN ONLY")
                        .font(Typography.label(9))
                        .kerning(1)
                        .foregroundStyle(Theme.heading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.10)))
                    Spacer()
                }
                Text("Last 30 days · estimated  \(CostModel.formatUsd(last30Total, decimals: 2))")
                    .font(Typography.body(13))
                    .foregroundStyle(Theme.body)

                if readyNotes.isEmpty {
                    Text("No ready notes yet — record one to see cost.")
                        .font(Typography.body(13))
                        .foregroundStyle(Theme.muted)
                } else {
                    ForEach(readyNotes.prefix(25)) { note in
                        let cost = CostModel.estimate(note: note)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(note.title)
                                .font(Typography.body(13))
                                .foregroundStyle(Theme.body)
                                .lineLimit(1)
                            HStack {
                                Text("\(String(format: "%.1f", cost.durationMinutes)) min · STT \(CostModel.formatUsd(cost.stt)) · LLM \(CostModel.formatUsd(cost.llm)) · Emb \(CostModel.formatUsd(cost.embedding))")
                                    .font(Typography.body(11))
                                    .foregroundStyle(Theme.muted)
                                Spacer()
                                Text(CostModel.formatUsd(cost.total))
                                    .font(Typography.label(11))
                                    .foregroundStyle(Theme.heading)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }

                Text("Estimated from char counts × published rates · not the actual billed amount.")
                    .font(Typography.body(10))
                    .foregroundStyle(Theme.tertiary)
            }
        }
    }
}
