import SwiftUI

/// Rate how good the transcription was.
///
/// This is the signal that tells us *which* notes transcribe badly — the
/// question the corpus cannot answer on its own. It appears once a note is
/// ready and there is a transcript to judge.
struct TranscriptRatingCard: View {
    /// Existing rating, so the card reflects a previous submission rather
    /// than inviting the user to rate the same note twice.
    let rating: Int?
    let isSaving: Bool
    let onRate: (Int) -> Void
    /// A10 #4: "report bad transcript" — routes to support so a low rating is
    /// not a dead end. Tapped explicitly, or surfaced automatically after a
    /// low star rating.
    var onReport: (() -> Void)?

    var body: some View {
        AlgoMinutesCard {
            VStack(spacing: Theme.Spacing.md) {
                Text(rating == nil ? "Rate transcription quality" : "Thanks — you rated this")
                    .font(Typography.heading(15, weight: .bold))
                    .foregroundStyle(Theme.heading)

                HStack(spacing: Theme.Spacing.md) {
                    ForEach(1...5, id: \.self) { star in
                        Button {
                            onRate(star)
                        } label: {
                            // Monochrome: a filled star reads as "selected"
                            // by weight, not by colour.
                            Image(systemName: (rating ?? 0) >= star ? "star.fill" : "star")
                                .font(.system(size: 22))
                                .foregroundStyle((rating ?? 0) >= star ? Theme.heading : Theme.tertiary)
                        }
                        .buttonStyle(CardButtonStyle())
                        .disabled(isSaving)
                        // 44pt hit target (tokens a11y.minTouchTargetPx) — the glyph is 22pt.
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                        .accessibilityLabel("\(star) star\(star == 1 ? "" : "s")")
                    }
                }
                .opacity(isSaving ? 0.5 : 1)

                if let onReport {
                    Button(action: onReport) {
                        Label("Report a problem with this transcript", systemImage: "exclamationmark.bubble")
                            .font(Typography.body(13))
                            .foregroundStyle(Theme.body)
                    }
                    .buttonStyle(CardButtonStyle())
                    .accessibilityHint("Sends a note reference to support. Never your audio or transcript.")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}
