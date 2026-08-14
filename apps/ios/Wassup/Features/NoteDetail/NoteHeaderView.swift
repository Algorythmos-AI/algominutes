import SwiftUI

/// Title and the meta line beneath it.
///
/// Size is not passed yet — it comes from Storage metadata, which only the
/// audio player fetches. `NoteMeta` collapses the separator around it, so this
/// renders correctly now and gains the size with no change here.
struct NoteHeaderView: View {
    let title: String
    let createdAt: Date?
    let durationSeconds: Double?
    var sizeBytes: Int64?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(Typography.heading(24, weight: .bold))
                .foregroundStyle(Theme.heading)
                .fixedSize(horizontal: false, vertical: true)

            let meta = NoteMeta.line(
                createdAt: createdAt,
                durationSeconds: durationSeconds,
                sizeBytes: sizeBytes
            )
            if !meta.isEmpty {
                Text(meta)
                    .font(Typography.body(13))
                    .monospacedDigit()
                    .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
