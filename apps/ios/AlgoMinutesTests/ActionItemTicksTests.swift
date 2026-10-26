import XCTest
@testable import AlgoMinutes

// MARK: - Action items can be ticked (RELEASE.md rev 11, UX12)
//
// The web could since #384; the iPhone drew them from the mirror, as text with no ids.

final class ActionItemTicksTests: XCTestCase {
    private let a = "11111111-1111-4111-8111-111111111111"
    private let b = "22222222-2222-4222-8222-222222222222"

    private func answer(_ items: String) -> Data {
        Data(#"{"note":{"id":"n1"},"summary":{"gist":"g","actionItems":[\#(items)],"keyDecisions":[]},"transcript":{"lines":[],"totalLines":0,"nextCursor":null}}"#.utf8)
    }

    func testItemsComeInTheServersOrderWithTheirTicks() throws {
        let ticks = try ActionItemTicks.parse(answer(#"{"id":"\#(a)","text":"Sam sends the deck","status":"done","assigneeName":null,"dueDate":null},{"id":"\#(b)","text":"Priya books the room","status":"open"}"#))
        XCTAssertEqual(ticks, [
            ActionItemTick(id: a, text: "Sam sends the deck", done: true),
            ActionItemTick(id: b, text: "Priya books the room", done: false),
        ])
    }

    func testAnItemWithoutAStringIdCannotBeTickedAndIsLeftOut() throws {
        let ticks = try ActionItemTicks.parse(answer(#"{"id":7,"text":"An old row","status":"open"},{"id":"\#(b)","text":"Priya books the room"}"#))
        XCTAssertEqual(ticks, [ActionItemTick(id: b, text: "Priya books the room", done: false)])
    }

    func testANoteWithoutASummaryHasNoItemsAndAnAnswerThatIsNotOneThrows() throws {
        XCTAssertEqual(try ActionItemTicks.parse(Data(#"{"note":{"id":"n1"},"summary":null}"#.utf8)), [])
        XCTAssertThrowsError(try ActionItemTicks.parse(Data("<html>".utf8)))
    }

    func testTicksShowOnlyWhenTheyAreTheItemsOnScreen() {
        let ticks = [ActionItemTick(id: a, text: "Sam sends the deck", done: true), ActionItemTick(id: b, text: "Priya books the room", done: false)]
        XCTAssertEqual(ActionItemTicks.matching(ticks, texts: ["Sam sends the deck", "Priya books the room"]), ticks)
        // Not read yet, edited since, reordered, or one item had no id: plain bullets.
        XCTAssertNil(ActionItemTicks.matching(nil, texts: ["Sam sends the deck"]))
        XCTAssertNil(ActionItemTicks.matching(ticks, texts: ["Sam sends the deck today", "Priya books the room"]))
        XCTAssertNil(ActionItemTicks.matching(ticks, texts: ["Priya books the room", "Sam sends the deck"]))
        XCTAssertNil(ActionItemTicks.matching(Array(ticks.prefix(1)), texts: ["Sam sends the deck", "Priya books the room"]))
    }

    func testATickChangesOneItemAndCanBePutBack() {
        let ticks = [ActionItemTick(id: a, text: "Sam sends the deck", done: false), ActionItemTick(id: b, text: "Priya books the room", done: false)]
        let ticked = ActionItemTicks.setting(ticks, id: b, done: true)
        XCTAssertEqual(ticked?.map(\.done), [false, true])
        XCTAssertEqual(ActionItemTicks.setting(ticked, id: b, done: false), ticks)
        XCTAssertNil(ActionItemTicks.setting(nil, id: b, done: true))
    }

    func testOnlyA404MeansTheItemIsGone() {
        XCTAssertTrue(ActionItemTicks.isGone(APIError.http(status: 404, message: "Action item not found")))
        XCTAssertFalse(ActionItemTicks.isGone(APIError.http(status: 500, message: nil)))
        XCTAssertFalse(ActionItemTicks.isGone(APIError.invalidResponse))
        XCTAssertFalse(ActionItemTicks.isGone(URLError(.notConnectedToInternet)))
    }
}
