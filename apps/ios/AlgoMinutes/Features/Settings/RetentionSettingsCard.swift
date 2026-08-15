import SwiftUI

/// A10 #5: note-retention picker.
///
/// Options are `ComplianceContract.retentionOptionsDays` plus "Keep until I
/// delete" (the default, sent to the server as null). The chosen value is
/// persisted locally for display and POSTed to `/v1/account/retention`; the
/// server is the source of truth for enforcement (see docs/DATA-RETENTION.md).
struct RetentionSettingsCard: View {
    @Environment(AppEnvironment.self) private var env

    /// Stored selection. Sentinel `0` = "keep until I delete" (options are all
    /// positive), so we can persist an Int and still express the null case.
    @AppStorage("note_retention_days") private var storedDays = 0

    @State private var isSaving = false
    @State private var errorMessage: String?

    /// Menu options: (label, days-or-nil).
    private var options: [(label: String, days: Int?)] {
        [("Keep until I delete", nil)]
            + ComplianceContract.retentionOptionsDays.map { ("\($0) days", $0) }
    }

    private var selectedDays: Int? { storedDays == 0 ? nil : storedDays }

    private var selectedLabel: String {
        options.first { $0.days == selectedDays }?.label ?? "Keep until I delete"
    }

    var body: some View {
        OwllCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Data retention")
                            .font(Typography.body(15))
                            .foregroundStyle(Theme.body)
                        Text("Automatically delete notes after this long.")
                            .font(Typography.body(12))
                            .foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Menu {
                        ForEach(options, id: \.label) { option in
                            Button {
                                select(option.days)
                            } label: {
                                if option.days == selectedDays {
                                    Label(option.label, systemImage: "checkmark")
                                } else {
                                    Text(option.label)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            if isSaving { ProgressView().controlSize(.small) }
                            Text(selectedLabel)
                                .font(Typography.label(14))
                                .foregroundStyle(Theme.heading)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.tertiary)
                        }
                    }
                    .disabled(isSaving)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.heading)
                }
            }
        }
    }

    private func select(_ days: Int?) {
        let previous = storedDays
        storedDays = days ?? 0
        errorMessage = nil
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await env.api.setRetention(days: days)
                AppLog.info("retention_set days=\(days.map { String($0) } ?? "keep")")
            } catch {
                AppLog.error("retention_set_failed: \(error.localizedDescription)")
                storedDays = previous // revert the visible selection
                errorMessage = "Couldn't update retention. Please try again."
            }
        }
    }
}
