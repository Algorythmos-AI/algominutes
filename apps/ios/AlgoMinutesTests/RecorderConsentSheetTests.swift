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

    func testTheOnlyOtherStepsAreTheOnesTheConsentLeadsTo() {
        // Exhaustive on purpose: a new step in front of the consent has to be added here, and argued for.
        for step in [RecorderConsentFlow.Step.consent, .broadcast, .micDenied] {
            switch step {
            case .consent, .broadcast, .micDenied: break
            }
        }
    }
}
