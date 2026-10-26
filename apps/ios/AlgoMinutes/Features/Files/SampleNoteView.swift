import SwiftUI

/// The example note (SampleNote), drawn with the same summary and transcript
/// panes as a real one, but none of a real note's actions: nothing here calls
/// the server, rates, retitles, asks the AI or deletes.
struct SampleNoteView: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case summary = "Summary"
        case transcript = "Transcript"
        var id: String { rawValue }
    }
    @State private var tab: Tab = .summary
    private let note = SampleNote.note

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Label("This is an example. Your recordings will look like this.", systemImage: "sparkles")
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.body)
                    .padding(Theme.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.md).fill(Theme.surfaceElevated))
                NoteHeaderView(title: note.title, createdAt: note.createdAtDate, durationSeconds: note.duration)
                Picker("Show", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                switch tab {
                case .summary:
                    SummaryPane(summary: note.summary)
                case .transcript:
                    TranscriptPane(lines: SampleNote.lines, rawText: nil)
                }
            }
            .padding(Theme.Spacing.xl)
        }
        .background(AlgoMinutesBackground())
        .navigationTitle("Example note")
        .navigationBarTitleDisplayMode(.inline)
    }
}
