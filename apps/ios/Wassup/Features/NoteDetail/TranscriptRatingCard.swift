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

    var body: some View {
        OwllCard {
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
                        .accessibilityLabel("\(star) star\(star == 1 ? "" : "s")")
                    }
                }
                .opacity(isSaving ? 0.5 : 1)
            }
            .frame(maxWidth: .infinity)
        }
    }
}
