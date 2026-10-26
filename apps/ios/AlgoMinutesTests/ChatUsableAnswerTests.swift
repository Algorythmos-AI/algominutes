import XCTest
@testable import AlgoMinutes

// MARK: - Chat answers you can use (RELEASE.md rev 11, UX9)
//
// An answer could only be read. It can now be copied or shared, without the
// [n] citation marks, which point at the chat's own source list.

final class ChatUsableAnswerTests: XCTestCase {
    func testTheCitationMarksAreTakenOutAndTheSpacingTidied() {
        XCTAssertEqual(
            ChatView.usableAnswer("We agreed the budget [1] and hiring opens in Sydney [2][3].", failed: false, streaming: false),
            "We agreed the budget and hiring opens in Sydney."
        )
        XCTAssertEqual(ChatView.usableAnswer("Ship on Friday [1], not Monday.", failed: false, streaming: false), "Ship on Friday, not Monday.")
    }

    func testLinesAndListsAreKept() {
        let answer = "Action items:\n- Sam sends the deck [1]\n- Priya books the room [2]"
        XCTAssertEqual(ChatView.usableAnswer(answer, failed: false, streaming: false), "Action items:\n- Sam sends the deck\n- Priya books the room")
    }

    func testNothingIsOfferedWhileItIsArrivingWhenItFailedOrWhenItIsEmpty() {
        XCTAssertNil(ChatView.usableAnswer("Half an ans", failed: false, streaming: true))
        XCTAssertNil(ChatView.usableAnswer("Something went wrong.", failed: true, streaming: false))
        XCTAssertNil(ChatView.usableAnswer("", failed: false, streaming: false))
        XCTAssertNil(ChatView.usableAnswer(" [1] ", failed: false, streaming: false))
    }

    func testThereAreThreeStartersAndEachIsAQuestionOrARequestWithinTheLimit() {
        XCTAssertEqual(ChatView.starterQuestions.count, 3)
        XCTAssertEqual(Set(ChatView.starterQuestions).count, 3)
        for question in ChatView.starterQuestions {
            XCTAssertEqual(QuestionLimit.cap(question), question)
            XCTAssertTrue(question.hasSuffix("?") || question.hasSuffix("."), question)
        }
    }
}
