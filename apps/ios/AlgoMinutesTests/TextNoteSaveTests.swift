import XCTest
@testable import AlgoMinutes

/// A scan, a PDF or an imported file is saved by the server (POST /v1/notes/text; plan rev 12 R12.8 PR 4, S16),
/// which writes Postgres first and then the doc the note list reads. The iPhone used to write the doc itself,
/// so Postgres never had the note: outside retention, backups, search and export.
final class TextNoteSaveTests: XCTestCase {
    private var api: APIClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { _ in (200, Data(#"{"noteId":"n1","status":"ready"}"#.utf8)) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        api = APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    private func respond(_ status: Int, _ json: String) {
        StubURLProtocol.responder = { _ in (status, Data(json.utf8)) }
    }

    private func pending(_ text: String = "Receipt\n\nCoffee 4.50", title: String? = "receipt") -> PendingTextNote {
        PendingTextNote(workspaceId: "workspace_u", text: text, source: .scannedImage, title: title, noteId: "n1")
    }

    func testSavesThroughTheServerWithTheContractBody() async throws {
        let outcome = await TextNoteSave.save(pending(), api: api)
        XCTAssertEqual(outcome, .saved(noteId: "n1"))
        let last = try XCTUnwrap(StubURLProtocol.recorded.last)
        XCTAssertEqual(last.method, "POST")
        XCTAssertEqual(last.url.path, "/v1/notes/text")
        XCTAssertEqual(last.headers["Authorization"], "Bearer test-token")
        XCTAssertEqual(last.body?["noteId"] as? String, "n1")
        XCTAssertEqual(last.body?["workspaceId"] as? String, "workspace_u")
        XCTAssertEqual(last.body?["text"] as? String, "Receipt\n\nCoffee 4.50")
        XCTAssertEqual(last.body?["source"] as? String, "scanned_image")
        XCTAssertEqual(last.body?["title"] as? String, "receipt")
    }

    func testNoTitleIsLeftOut() async throws {
        _ = await TextNoteSave.save(pending(title: nil), api: api)
        XCTAssertNil(StubURLProtocol.recorded.last?.body?["title"])
    }

    // Nothing is lost on a failure: the sheet keeps the text, and Try again sends the same note (a retry the server
    // already saved answers ready, not a second note).
    func testAFailureKeepsTheTextAndTryAgainIsTheSameNote() async {
        respond(503, #"{"error":"Saving is unavailable right now. Please try again shortly."}"#)
        let outcome = await TextNoteSave.save(pending(), api: api)
        guard case .failed(let message, let retry) = outcome else { return XCTFail("expected a failure, got \(outcome)") }
        XCTAssertEqual(message, "Saving is unavailable right now. Please try again shortly.")
        XCTAssertEqual(retry, pending())
    }

    // That id was deleted, or is another note's: Try again saves the text under a new one.
    func testADeletedOrTakenIdIsRetriedUnderANewOne() async {
        for status in [404, 409] {
            respond(status, #"{"error":"text_note_conflict"}"#)
            let outcome = await TextNoteSave.save(pending(), api: api)
            guard case .failed(_, let retry) = outcome else { return XCTFail("\(status): expected a failure") }
            XCTAssertNotEqual(retry.noteId, "n1", "\(status)")
            XCTAssertEqual(retry.text, pending().text, "\(status)")
        }
    }

    func testANewIdIsOneTheServerAccepts() {
        let id = PendingTextNote.newId()
        XCTAssertTrue(id.range(of: #"^[a-zA-Z0-9_\-]{1,128}$"#, options: .regularExpression) != nil, id)
        XCTAssertNotEqual(id, PendingTextNote.newId())
    }

    // The server keeps 180,000 characters and marks the note truncated past them; the contract takes at most
    // 300,000 UTF-16 units. One character past the limit is sent, so the server still marks it.
    func testALongTextIsCutJustPastWhatTheServerKeeps() {
        let short = "Receipt\n\nCoffee"
        XCTAssertEqual(TextNoteSave.requestText(short), short)
        let long = String(repeating: "a", count: 250_000)
        XCTAssertEqual(TextNoteSave.requestText(long).count, 180_001)
    }

    func testATextOfWideCharactersStaysInsideTheContractAtACharacterBoundary() {
        let wide = String(repeating: "👍🏽", count: 100_000) // 4 UTF-16 units each
        let cut = TextNoteSave.requestText(wide)
        XCTAssertLessThanOrEqual(cut.utf16.count, 300_000)
        XCTAssertEqual(cut.utf16.count, 300_000)
        XCTAssertTrue(cut.allSatisfy { $0 == "👍🏽" })
    }

    func testATitleStaysInsideTheContract() {
        XCTAssertEqual(TextNoteSave.requestTitle(String(repeating: "t", count: 400))?.utf16.count, 300)
        XCTAssertNil(TextNoteSave.requestTitle("   "))
        XCTAssertEqual(TextNoteSave.requestTitle(" Q3 report "), "Q3 report")
    }
}
