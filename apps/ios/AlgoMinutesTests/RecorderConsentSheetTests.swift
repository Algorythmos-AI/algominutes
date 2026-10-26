import XCTest
@testable import AlgoMinutes

// MARK: - One consent sheet (RELEASE.md rev 11, H13 / UX2)
//
// The sheet opens at the consent itself. The "Ready to record?" step before it
// repeated the same words and cost a tap before every recording.

final class RecorderConsentSheetTests: XCTestCase {
    func testTheSheetOpensAtTheConsentWithNoStepBeforeIt() {
        XCTAssertEqual(RecorderConsentFlow.firstStep, .consent)
    }

    // RELEASE.md rev 11, H19 / UX11.
    func testRecordingACallIsNamedForTheCallAndTakesThreeSteps() {
        XCTAssertTrue(RecorderConsentFlow.callTitle.hasPrefix("Record a call"))
        for app in ["Zoom", "Teams", "Meet"] { XCTAssertTrue(RecorderConsentFlow.callTitle.contains(app), app) }
        XCTAssertEqual(RecorderConsentFlow.callSteps.count, 3)
    }

    func testTheMicrophoneHasItsOwnStepBeforeTheBroadcastStarts() throws {
        let steps = RecorderConsentFlow.callSteps
        let mic = try XCTUnwrap(steps.firstIndex { $0.contains("Microphone on") })
        let start = try XCTUnwrap(steps.firstIndex { $0.contains("Start Broadcast") })
        XCTAssertLessThan(mic, start)
        XCTAssertTrue(RecorderConsentFlow.callAfterwards.contains("red indicator"))
    }

    func testTheOnlyOtherStepsAreTheOnesTheConsentLeadsTo() {
        // Exhaustive on purpose: a new step in front of the consent has to be added here, and argued for.
        for step in [RecorderConsentFlow.Step.consent, .broadcast, .micDenied] {
            switch step {
            case .consent, .broadcast, .micDenied: break
            }
        }
    }
}
