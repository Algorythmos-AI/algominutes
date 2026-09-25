import XCTest
@testable import AlgoMinutes

/// Records every request and answers from `responder`. Installed on an
/// ephemeral URLSession handed to APIClient, so nothing leaves the process.
final class StubURLProtocol: URLProtocol {
    struct Recorded {
        let method: String
        let url: URL
        let headers: [String: String]
        let body: [String: Any]?
    }

    nonisolated(unsafe) static var recorded: [Recorded] = []
    nonisolated(unsafe) static var responder: (URLRequest) -> (Int, Data) = { _ in (200, Data("{}".utf8)) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var bodyData = request.httpBody
        if bodyData == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            bodyData = data
        }
        let body = bodyData.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        Self.recorded.append(Recorded(
            method: request.httpMethod ?? "",
            url: request.url!,
            headers: request.allHTTPHeaderFields ?? [:],
            body: body
        ))
        let (status, data) = Self.responder(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Every call goes to its /v1 route, on the right host, with the right method
/// and body, carrying the auth token and the X-AlgoMinutes-Client header the api
/// requires (it answers 400 without it and 426 below its minimum).
final class APIClientTests: XCTestCase {
    private var api: APIClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
        StubURLProtocol.responder = { _ in (200, Data("{}".utf8)) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        api = APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    private func respond(_ json: String, status: Int = 200) {
        StubURLProtocol.responder = { _ in (status, Data(json.utf8)) }
    }

    private var last: StubURLProtocol.Recorded { StubURLProtocol.recorded.last! }

    private func assertRequest(
        _ method: String, _ path: String, host: String = AppConfig.apiBaseURL.host!,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(last.method, method, file: file, line: line)
        XCTAssertEqual(last.url.host, host, file: file, line: line)
        XCTAssertEqual(last.url.path, path, file: file, line: line)
        XCTAssertEqual(last.headers["Authorization"], "Bearer test-token", file: file, line: line)
        XCTAssertEqual(last.headers[APIClient.clientHeader], APIClient.clientHeaderValue, file: file, line: line)
        XCTAssertTrue(APIClient.clientHeaderValue.hasPrefix("ios/"), file: file, line: line)
    }

    func testProcessGoesToV1WithTheDurationAndDeviceHeaders() async throws {
        try await api.processAudio(.init(
            noteId: "n1", workspaceId: "workspace_u", type: .recording,
            storagePath: "recordings/workspace_u/n1.m4a", mimeType: "audio/mp4", retryAttempt: 2, durationSec: 150
        ))
        assertRequest("POST", "/v1/process")
        XCTAssertEqual(last.body?["noteId"] as? String, "n1")
        XCTAssertEqual(last.body?["type"] as? String, "recording")
        XCTAssertEqual(last.body?["durationSec"] as? Double, 150)
        XCTAssertNil(last.body?["retryAttempt"], "not part of ProcessRequest")
        XCTAssertEqual(last.headers["X-Device-Platform"], DeviceAttestationService.platformHeaderValue)
    }

    func testUploadSessionRoutes() async throws {
        respond(#"{"uploadId":"u-1","sessionUri":"https://storage.googleapis.com/s","storagePath":"recordings/workspace_u/n1.m4a","chunkSize":8388608,"expiresAt":"2026-10-02T00:00:00Z"}"#)
        let created = try await api.createUploadSession(
            noteId: "n1", workspaceId: "workspace_u", fileName: "a.m4a", contentType: "audio/mp4", totalBytes: 10
        )
        assertRequest("POST", "/v1/uploads")
        XCTAssertEqual(created.uploadId, "u-1")
        XCTAssertEqual(last.body?["totalBytes"] as? Int, 10)

        respond(#"{"uploadId":"u-1","receivedBytes":5,"complete":false}"#)
        let status = try await api.uploadSessionStatus(uploadId: "u-1")
        assertRequest("GET", "/v1/uploads/u-1")
        XCTAssertNil(last.body)
        XCTAssertEqual(status.receivedBytes, 5)

        respond(#"{"uploadId":"u-1","storagePath":"recordings/workspace_u/n1.m4a","complete":true}"#)
        let done = try await api.completeUpload(uploadId: "u-1")
        assertRequest("POST", "/v1/uploads/u-1/complete")
        XCTAssertTrue(done.complete)
    }

    func testEntitlementIsAGet() async throws {
        respond(#"{"state":"trialing","plan":"free","billingPeriod":"2026-09","includedMinutes":600,"usedMinutes":3,"remainingMinutes":597,"overQuota":false,"trialEndsAt":"2026-10-01T00:00:00Z"}"#)
        let entitlement = try await api.fetchEntitlement()
        assertRequest("GET", "/v1/entitlement")
        XCTAssertNil(last.body)
        XCTAssertEqual(entitlement.state, .trialing)
    }

    func testPurchasesGoToTheBillingHost() async throws {
        respond(#"{"ok":true,"entitlementState":"active"}"#)
        let r = try await api.verifyPurchase(jws: "jws")
        assertRequest("POST", "/v1/purchases/verify", host: AppConfig.billingBaseURL.host!)
        XCTAssertEqual(last.body?["rail"] as? String, "apple_storekit")
        XCTAssertEqual(r.entitlementState, "active")
    }

    func testNoteAndAccountRoutes() async throws {
        respond(#"{"ok":true,"noteId":"n1","deleted":true}"#)
        let deleted = try await api.deleteNote(noteId: "n1", workspaceId: "workspace_u")
        assertRequest("POST", "/v1/notes/delete")
        XCTAssertTrue(deleted)
        XCTAssertEqual(last.body?["workspaceId"] as? String, "workspace_u")

        respond("{}")
        try await api.updateNote(noteId: "n1", workspaceId: "workspace_u", title: "T")
        assertRequest("POST", "/v1/notes/update")
        try await api.submitFeedback(noteId: "n1", workspaceId: "workspace_u", rating: 5)
        assertRequest("POST", "/v1/notes/feedback")
        try await api.deleteAccount()
        assertRequest("POST", "/v1/account/delete")
        try await api.registerPushToken(token: "t")
        assertRequest("POST", "/v1/push/register")
        _ = try await api.search(query: "q")
        assertRequest("POST", "/v1/search")
        try await api.acceptTerms(termsVersion: "1", privacyVersion: "1")
        assertRequest("POST", "/v1/account/accept-terms")
        try await api.setRetention(days: 30)
        assertRequest("POST", "/v1/account/retention")
        try await api.submitSupport(kind: .contact, message: "hi")
        assertRequest("POST", "/v1/support")
        try await api.track(event: .paywallViewed)
        assertRequest("POST", "/v1/events")

        respond(#"{"ok":true,"generation":3}"#)
        let generation = try await api.regenerateSummary(noteId: "n1", workspaceId: "workspace_u")
        assertRequest("POST", "/v1/notes/regenerate-summary")
        XCTAssertEqual(generation, 3)

        respond(#"{"url":"https://algominutes.com/s/x","shareId":"s-1","expiresAt":null}"#)
        let link = try await api.createShareLink(noteId: "n1", workspaceId: "workspace_u")
        assertRequest("POST", "/v1/shares/create")
        XCTAssertEqual(link.shareId, "s-1")
        respond(#"{"revoked":true}"#)
        _ = try await api.revokeShareLink(noteId: "n1", workspaceId: "workspace_u", shareId: "s-1")
        assertRequest("POST", "/v1/shares/revoke")

        respond(#"{"transcript":{"lines":[{"id":"l1","text":"hi","startMs":0}],"totalLines":1,"nextCursor":null}}"#)
        let page = try await api.fetchTranscriptPage(noteId: "n1", workspaceId: "workspace_u")
        assertRequest("POST", "/v1/notes/read")
        XCTAssertEqual(page.lines.count, 1)

        StubURLProtocol.responder = { _ in (200, Data([0x50, 0x4B])) }
        let docx = try await api.exportNote(noteId: "n1", workspaceId: "workspace_u", scope: .both)
        assertRequest("POST", "/v1/export")
        XCTAssertEqual(docx.count, 2)
    }

    func testAnOutdatedAppGetsUpdateRequiredAndASpentQuotaGetsQuotaExceeded() async {
        respond(#"{"error":"please_update","message":"Please update AlgoMinutes to continue."}"#, status: 426)
        do {
            _ = try await api.search(query: "q")
            XCTFail("expected updateRequired")
        } catch APIError.updateRequired {
        } catch { XCTFail("unexpected \(error)") }

        respond(#"{"error":"quota_exceeded"}"#, status: 402)
        do {
            try await api.processAudio(.init(noteId: "n1", workspaceId: "w", type: .recording))
            XCTFail("expected quotaExceeded")
        } catch APIError.quotaExceeded {
        } catch { XCTFail("unexpected \(error)") }
    }

    func testChatStreamsFromV1OnTheInjectedSession() async throws {
        StubURLProtocol.responder = { _ in (200, Data("data: {\"type\":\"done\"}\n\n".utf8)) }
        for try await _ in api.chatStream(query: "q", noteId: "n1") {}
        assertRequest("POST", "/v1/chat")
        XCTAssertEqual(last.body?["noteId"] as? String, "n1")
    }
}
