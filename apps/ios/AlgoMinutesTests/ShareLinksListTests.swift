import XCTest
@testable import AlgoMinutes

// MARK: - The links already made for a note (RELEASE.md rev 11, H20)
//
// A link could only be stopped in the minute it was made. The sheet now lists
// them: when each was made, whether it still opens, how often it was read.

final class ShareLinksListTests: XCTestCase {
    private func row(_ over: [String: Any] = [:]) -> [String: Any] {
        var json: [String: Any] = [
            "shareId": "5f0c1a52-7d0e-4b41-9a36-2f1f6f3f8a10",
            "scope": "both",
            "createdAt": "2026-10-01T02:00:00.000Z",
            "expiresAt": "2026-10-08T02:00:00.000Z",
            "revokedAt": NSNull(),
            "lastReadAt": NSNull(),
            "readCount": 3,
            "live": true,
        ]
        for (key, value) in over { json[key] = value }
        return json
    }

    private let format: (Date) -> String = { _ in "8 Oct" }

    func testALiveLinkDecodesAndSaysUntilWhenItOpens() throws {
        let link = try XCTUnwrap(APIClient.ListedShareLink(json: row()))
        XCTAssertEqual(link.shareId, "5f0c1a52-7d0e-4b41-9a36-2f1f6f3f8a10")
        XCTAssertTrue(link.live)
        XCTAssertNotNil(link.createdAt)
        XCTAssertNil(link.revokedAt)
        XCTAssertEqual(link.stateText(format: format), "opens until 8 Oct")
        XCTAssertEqual(link.readText, "read 3 times")
    }

    func testAStoppedLinkSaysStoppedAndAnExpiredOneExpired() throws {
        let stopped = try XCTUnwrap(APIClient.ListedShareLink(json: row(["live": false, "revokedAt": "2026-10-02T00:00:00.000Z", "readCount": 1])))
        XCTAssertEqual(stopped.stateText(format: format), "stopped")
        XCTAssertEqual(stopped.readText, "read once")
        let expired = try XCTUnwrap(APIClient.ListedShareLink(json: row(["live": false])))
        XCTAssertEqual(expired.stateText(format: format), "expired")
    }

    func testALinkWithNoExpiryStillOpens() throws {
        let link = try XCTUnwrap(APIClient.ListedShareLink(json: row(["expiresAt": NSNull()])))
        XCTAssertEqual(link.stateText(format: format), "still opens")
    }

    func testANumericIdIsAccepted() throws {
        // The contract allows a string or a number.
        let link = try XCTUnwrap(APIClient.ListedShareLink(json: row(["shareId": 42])))
        XCTAssertEqual(link.shareId, "42")
    }

    func testARowThatCannotBeStoppedIsNotShown() {
        XCTAssertNil(APIClient.ListedShareLink(json: row(["shareId": NSNull()])))
        XCTAssertNil(APIClient.ListedShareLink(json: row(["shareId": ""])))
    }

    func testALinkIsOnlyStoppableWhenTheServerSaysItStillOpens() throws {
        var json = row()
        json.removeValue(forKey: "live")
        XCTAssertFalse(try XCTUnwrap(APIClient.ListedShareLink(json: json)).live)
    }

    func testTheRowNeverShowsALinkOrAToken() throws {
        let link = try XCTUnwrap(APIClient.ListedShareLink(json: row(["token": "tok_secret", "url": "https://example.test/app/s/tok_secret"])))
        let words = ShareExportSheet.linkSummary(link)
        XCTAssertFalse(words.contains("tok_secret"), words)
        XCTAssertFalse(words.contains("http"), words)
        XCTAssertTrue(words.hasPrefix("Made "), words)
    }
}
