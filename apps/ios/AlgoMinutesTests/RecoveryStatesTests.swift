import XCTest
@testable import AlgoMinutes

/// Getting back from a failure without starting over (RELEASE.md PR 10c):
/// a failed chat answer can be asked again in place.
@MainActor
final class RecoveryStatesTests: XCTestCase {
    private func model() -> ChatViewModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let vm = ChatViewModel()
        vm.attach(api: APIClient(session: URLSession(configuration: config), idToken: { "test-token" }))
        return vm
    }

    private func finish(_ vm: ChatViewModel) async {
        for _ in 0..<500 where vm.isStreaming { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(vm.isStreaming, "the stream never finished")
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
    }

    func testAFailedAnswerRemembersItsQuestionAndRetryAsksAgainInPlace() async {
        let vm = model()
        StubURLProtocol.responder = { _ in (500, Data(#"{"error":"boom"}"#.utf8)) }
        vm.draft = "what did we decide?"
        vm.send()
        await finish(vm)
        XCTAssertEqual(vm.messages.count, 2)
        let failed = vm.messages[1]
        XCTAssertEqual(failed.failedQuery, "what did we decide?")

        StubURLProtocol.responder = { _ in (200, Data("data: {\"text\":\"Ship on Friday.\"}\n\nevent: done\ndata: {}\n\n".utf8)) }
        vm.retry(messageId: failed.id)
        await finish(vm)
        // Asked again in the same place: still one question and one answer.
        XCTAssertEqual(vm.messages.count, 2)
        XCTAssertEqual(vm.messages[1].id, failed.id)
        XCTAssertEqual(vm.messages[1].content, "Ship on Friday.")
        XCTAssertNil(vm.messages[1].failedQuery)
        let chats = StubURLProtocol.recorded.filter { $0.url.path == "/v1/chat" }
        XCTAssertEqual(chats.count, 2)
        XCTAssertEqual(chats.map { $0.body?["query"] as? String }, ["what did we decide?", "what did we decide?"])
    }

    func testAServerErrorInTheStreamIsRetryableToo() async {
        let vm = model()
        StubURLProtocol.responder = { _ in (200, Data("event: error\ndata: {\"error\":\"stream_failed\"}\n\n".utf8)) }
        vm.draft = "q"
        vm.send()
        await finish(vm)
        XCTAssertEqual(vm.messages[1].failedQuery, "q")
    }

    func testANormalAnswerHasNothingToRetry() async {
        let vm = model()
        StubURLProtocol.responder = { _ in (200, Data("data: {\"text\":\"ok\"}\n\nevent: done\ndata: {}\n\n".utf8)) }
        vm.draft = "q"
        vm.send()
        await finish(vm)
        XCTAssertNil(vm.messages[1].failedQuery)
        vm.retry(messageId: vm.messages[1].id) // no-op
        XCTAssertEqual(StubURLProtocol.recorded.filter { $0.url.path == "/v1/chat" }.count, 1)
    }

    func testTheSyncBannerSaysWhatIsHappening() {
        XCTAssertTrue(NotesSyncBanner.message.contains("Reconnecting"))
        XCTAssertTrue(NotesSyncBanner.detail.contains("out of date"))
    }
}
