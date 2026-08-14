import SwiftUI

/// Shown while a note is still moving through the pipeline.
///
/// Takes a resolved `NoteProcessingStage` rather than a note, so the rule
/// about never inventing a percentage lives in one testable place and this
/// pane only draws what it is handed.
struct ProcessingPane: View {
    let stage: NoteProcessingStage

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
            OwllCard {
                HStack(spacing: Theme.Spacing.lg) {
                    ProgressRing(stage: stage)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(stage.label)
                            .font(Typography.heading(17, weight: .bold))
                            .foregroundStyle(Theme.heading)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(NoteProcessingStage.backgroundNotice)
                            .font(Typography.body(13))
                            .foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
            }

            // Stands in for the transcript that is on its way, so the screen
            // has the shape of the thing being waited for rather than a void.
            SkeletonBlock()
                .padding(.horizontal, Theme.Spacing.xs)
        }
    }
}
