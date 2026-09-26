import XCTest
@testable import AlgoMinutes

/// A tapped push or an algominutes://note link opens that note, from any tab.
@MainActor
final class DeepLinkRouterTests: XCTestCase {
    private let router = DeepLinkRouter.shared

    override func setUp() {
        super.setUp()
        router.pendingNoteId = nil
    }

    func testAPushWithADeepLinkRoutesToItsNote() {
        let before = router.arrivals
        router.handle(userInfo: ["noteId": "other", "deepLink": DeepLink.noteURL(noteId: "note-1")])
        XCTAssertEqual(router.pendingNoteId, "note-1")
        XCTAssertEqual(router.arrivals, before + 1)
    }

    func testAPushWithOnlyANoteIdStillRoutes() {
        let before = router.arrivals
        router.handle(userInfo: ["noteId": "note-2"])
        XCTAssertEqual(router.pendingNoteId, "note-2")
        XCTAssertEqual(router.arrivals, before + 1)
    }

    func testAPushWithNoNoteChangesNothing() {
        let before = router.arrivals
        router.handle(userInfo: ["aps": ["alert": "hi"]])
        router.open(noteId: "")
        XCTAssertNil(router.pendingNoteId)
        XCTAssertEqual(router.arrivals, before)
    }

    // Home clears the id as soon as it navigates, so the tab bar can't rely on
    // it: every arrival counts, the same note twice included.
    func testEveryArrivalCountsEvenAfterHomeClearedTheId() {
        let before = router.arrivals
        router.open(noteId: "note-3")
        router.pendingNoteId = nil
        router.open(noteId: "note-3")
        XCTAssertEqual(router.arrivals, before + 2)
        XCTAssertEqual(router.pendingNoteId, "note-3")
    }

    func testOnlyNoteLinksInOurSchemeParse() {
        XCTAssertEqual(DeepLink.noteId(fromString: "algominutes://note/abc"), "abc")
        XCTAssertNil(DeepLink.noteId(fromString: "algominutes://note/"))
        XCTAssertNil(DeepLink.noteId(fromString: "algominutes://settings/abc"))
        XCTAssertNil(DeepLink.noteId(fromString: "https://note/abc"))
    }
}
