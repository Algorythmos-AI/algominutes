import XCTest
@testable import AlgoMinutes

/// The contract's `/v1` fixtures (`packages/contracts/fixtures/v1`), decoded with the app's own models
/// (RELEASE.md PR 30d, S2-PR9). The root test `tests/contract-fixtures.test.ts` checks the same files against
/// the server's zod schemas, so a server change this build can't read fails here, not on a tester's phone.
final class ContractFixturesTests: XCTestCase {
    private func cases(_ file: String) throws -> [String: Data] {
        let dir = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "v1", withExtension: nil), "the fixtures folder isn't in the test bundle")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent(file)))
        let object = try XCTUnwrap(json as? [String: Any])
        return try object.mapValues { try JSONSerialization.data(withJSONObject: $0) }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        try JSONDecoder().decode(type, from: try XCTUnwrap(data, file: file, line: line))
    }

    func testEntitlementEveryCaseAndWhatTheAppMakesOfIt() throws {
        let c = try cases("entitlement.json")
        XCTAssertEqual(c.count, 6)
        for (name, data) in c { XCTAssertNoThrow(try JSONDecoder().decode(EntitlementResponse.self, from: data), name) }

        let grant = try decode(EntitlementResponse.self, c["beta_minutes"])
        XCTAssertTrue(grant.isGrant)
        XCTAssertFalse(grant.isSubscription)
        let apple = try decode(EntitlementResponse.self, c["app_store_subscriber"])
        XCTAssertTrue(apple.isSubscription)
        XCTAssertTrue(apple.isManagedInAppStore)
        let web = try decode(EntitlementResponse.self, c["web_subscriber"])
        XCTAssertTrue(web.isSubscription)
        XCTAssertFalse(web.isManagedInAppStore)
        // An older server says only "active": a subscription, as before PR 26b.
        let older = try decode(EntitlementResponse.self, c["older_server"])
        XCTAssertNil(older.source)
        XCTAssertTrue(older.isSubscription)
        XCTAssertNil(older.includedMinutes)
        XCTAssertTrue(try decode(EntitlementResponse.self, c["free_floor_over_quota"]).gatesMeteredActions)
        XCTAssertEqual(try decode(EntitlementResponse.self, c["trialing"]).state, .trialing)
    }

    func testRedeemInviteAndVerifyPurchase() throws {
        let invite = try cases("redeem-invite.json")
        let withBot = try decode(RedeemInviteResponse.self, invite["with_notetaker"])
        XCTAssertTrue(withBot.notetaker)
        XCTAssertTrue(withBot.entitlement.isGrant)
        XCTAssertNil(try decode(RedeemInviteResponse.self, invite["until_revoked"]).grantEndsAt)
        let purchase = try decode(VerifyPurchaseResponse.self, try cases("verify-purchase.json")["active"])
        XCTAssertTrue(purchase.ok)
        XCTAssertEqual(purchase.entitlementState, "active")
    }

    func testAppConfigIncludingAnOlderServer() throws {
        let c = try cases("app-config.json")
        let on = try decode(AppConfigResponse.self, c["everything_on"])
        XCTAssertEqual(on.notetaker?.bot, true)
        XCTAssertEqual(on.shareLinks, true)
        XCTAssertFalse(try decode(AppConfigResponse.self, c["broadcast_off"]).broadcastCapture)
        let older = try decode(AppConfigResponse.self, c["older_server"])
        XCTAssertNil(older.notetaker)
        XCTAssertNil(older.shareLinks)
    }

    func testUploads() throws {
        let c = try cases("uploads.json")
        let session = try decode(APIClient.CreateUploadSessionResponse.self, c["session"])
        XCTAssertEqual(session.chunkSize, 8_388_608)
        XCTAssertEqual(try decode(APIClient.UploadSessionStatus.self, c["status"]).receivedBytes, 8_388_608)
        XCTAssertTrue(try decode(APIClient.CompleteUploadResponse.self, c["complete"]).complete)
    }

    func testRetentionSearchAndTranscript() throws {
        let retention = try cases("retention.json")
        XCTAssertEqual(try decode(APIClient.RetentionResponse.self, retention["thirty_days"]).retentionDays, 30)
        XCTAssertNil(try decode(APIClient.RetentionResponse.self, retention["keep"]).retentionDays)

        // Search: the app decodes the hits array out of the body (APIClient.search).
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(try cases("search.json")["hits"])) as? [String: Any])
        let hits = try JSONDecoder().decode([SearchHit].self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(body["hits"])))
        XCTAssertEqual(hits.map(\.noteId), ["n1", "n2"])
        XCTAssertNil(hits[1].noteTitle)

        let page = try decode(TranscriptPageResponse.self, try cases("note-page.json")["page"])
        XCTAssertEqual(page.transcript.lines.map(\.id), ["l1", "l2"])
        XCTAssertNil(page.transcript.lines[1].speaker)
        XCTAssertEqual(page.transcript.nextCursor, "c2")
    }
}
