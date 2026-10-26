import Foundation

/// A finished note to look at before the first recording (RELEASE.md PR 10b;
/// A6.4's "sample note", the biggest first-run gap). It lives only in the app:
/// it's never in the notes list's data, never synced, searched, deleted or sent
/// anywhere, and it has no audio. Files shows it while there are no notes yet.
enum SampleNote {
    static let id = "sample-note"

    static let note = Note(
        id: id,
        title: "Weekly product sync (example)",
        workspaceId: "",
        authorId: "",
        status: .ready,
        type: .recording,
        sourceUrl: nil,
        duration: 1_860,
        wordCount: 4_120,
        createdAt: "2026-09-21T23:00:00.000Z",
        updatedAt: "2026-09-21T23:31:00.000Z",
        lastProgressAt: nil,
        summary: Summary(
            gist: "The team agreed to ship the new onboarding to beta testers on Friday, moved the pricing page to next sprint, and asked Priya to confirm the support rota before launch.",
            actionItems: [
                "Priya: confirm the weekend support rota by Wednesday",
                "Tom: finish the onboarding copy and share it for review",
                "Alex: book the beta testers' kickoff call",
            ],
            keyDecisions: [
                "Ship the new onboarding to beta testers on Friday",
                "Move the pricing page to next sprint",
            ],
            keyPoints: nil,
            chapters: [
                SummaryChapter(startMs: 0, title: "Where the beta stands", summary: "Onboarding is ready apart from its copy; two bugs from last week are fixed."),
                SummaryChapter(startMs: 540_000, title: "Pricing page", summary: "Not ready: waiting on the cost figures, so it moves to next sprint."),
                SummaryChapter(startMs: 1_260_000, title: "Launch support", summary: "Weekend cover is needed for the first beta weekend."),
            ]
        ),
        transcript: lines,
        transcriptTruncated: false,
        rawText: nil,
        errorMessage: nil,
        diagnosticCode: nil,
        storagePath: nil,
        mimeType: nil,
        jobId: nil,
        progress: nil,
        retryAttempt: nil
    )

    private static let script: [(String, String, String)] = [
        ("Alex", "0:04", "Morning, everyone. Let's start with where the beta stands."),
        ("Tom", "0:11", "Onboarding is done apart from the copy. Both bugs from last week are fixed."),
        ("Alex", "0:24", "Great. Can we get it to testers this week?"),
        ("Tom", "0:29", "If the copy's reviewed by Thursday, Friday works."),
        ("Priya", "0:37", "I can review it Thursday morning."),
        ("Alex", "0:43", "Then let's ship to beta testers on Friday."),
        ("Alex", "9:02", "Next, the pricing page."),
        ("Priya", "9:08", "We're still waiting on the cost figures, so it isn't ready."),
        ("Alex", "9:21", "Let's move it to next sprint rather than rush it."),
        ("Tom", "9:26", "Agreed."),
        ("Alex", "21:05", "Last thing: support for the launch weekend."),
        ("Priya", "21:12", "We need someone on call Saturday and Sunday."),
        ("Priya", "21:20", "I'll confirm the rota by Wednesday."),
        ("Alex", "21:31", "And I'll book the kickoff call with the beta testers."),
        ("Alex", "30:48", "Thanks, all. Same time next week."),
    ]

    static let lines: [TranscriptLine] = script.enumerated().map { i, line in
        TranscriptLine(index: i, speaker: line.0, text: line.2, time: line.1, startMs: nil)
    }

    /// Show it while the user has no notes yet: after the list has loaded (so it
    /// never flashes during loading), with no search typed, under a filter that
    /// takes a voice note, and until hidden.
    static func shouldShow(notesEmpty: Bool, query: String, hasLoaded: Bool, hidden: Bool,
                           filterMatches: Bool = true) -> Bool {
        notesEmpty && hasLoaded && !hidden && filterMatches
            && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
