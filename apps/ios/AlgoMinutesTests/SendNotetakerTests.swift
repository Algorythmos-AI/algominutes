import XCTest
@testable import AlgoMinutes

/// Sending the notetaker from iOS (RELEASE.md PR 25; CONSENT.md §2.4): the
/// affirmation gates every send, a retry reuses its request id, one already on
/// its way opens its note, and a refusal says why in the server's words.
@MainActor
final class SendNotetakerTests: XCTestCase {
    func testAMeetLinkAsPeoplePasteIt_andNothingElse() {
        XCTAssertEqual(NotetakerLink.meetingURL(from: " https://meet.google.com/abc-defg-hij "), "https://meet.google.com/abc-defg-hij")
        XCTAssertEqual(NotetakerLink.meetingURL(from: "meet.google.com/abc-defg-hij?authuser=1"), "https://meet.google.com/abc-defg-hij?authuser=1")
        XCTAssertEqual(NotetakerLink.meetingURL(from: "http://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij")
        for bad in ["", "https://meet.google.com/", "https://meet.google.com.evil.example/abc-defg-hij",
                    "https://zoom.us/j/1", "https://user@meet.google.com/abc-defg-hij", "https://meet.google.com:8443/abc-defg-hij",
                    "https://meet.google.com/abcd-efg-hij"] {
            XCTAssertNil(NotetakerLink.meetingURL(from: bad), bad)
        }
    }

    func testNothingIsSentUntilTheAffirmationIsTicked() async {
        let model = SendNotetakerModel(makeId: { "id-1" })
        model.link = "meet.google.com/abc-defg-hij"
        XCTAssertFalse(model.canSend)
        var calls = 0
        let none = await model.send { _, _, _ in calls += 1; return .sent(botId: "b", noteId: "n") }
        XCTAssertNil(none)
        XCTAssertEqual(calls, 0)
        model.agreed = true
        XCTAssertTrue(model.canSend)
        model.link = "https://zoom.us/j/1"
        XCTAssertFalse(model.canSend)
        XCTAssertTrue(model.linkIsWrong)
    }

    func testSendsTheLinkTitleAndId_thenOpensTheNote() async {
        var ids = ["id-1", "id-2"]
        let model = SendNotetakerModel(makeId: { ids.removeFirst() })
        model.link = "meet.google.com/abc-defg-hij"
        model.title = "  Weekly sync "
        model.agreed = true
        var sent: [(String, String?, String)] = []
        let noteId = await model.send { url, title, id in sent.append((url, title, id)); return .sent(botId: "b1", noteId: "mtg_new") }
        XCTAssertEqual(noteId, "mtg_new")
        XCTAssertEqual(sent.first?.0, "https://meet.google.com/abc-defg-hij")
        XCTAssertEqual(sent.first?.1, "Weekly sync")
        XCTAssertEqual(sent.first?.2, "id-1")
    }

    func testARetryReusesItsId_anotherMeetingGetsANewOne_andOneOnItsWayOpensItsNote() async {
        var n = 0
        let model = SendNotetakerModel(makeId: { n += 1; return "id-\(n)" })
        model.link = "https://meet.google.com/abc-defg-hij"
        model.agreed = true
        var ids: [String] = []
        _ = await model.send { _, _, id in ids.append(id); throw APIError.http(status: 503, message: "The notetaker is busy right now. Please try again in a few minutes.") }
        XCTAssertEqual(model.error, "The notetaker is busy right now. Please try again in a few minutes.")
        let again = await model.send { _, _, id in ids.append(id); return .alreadyOnItsWay(noteId: "mtg_old") }
        XCTAssertEqual(again, "mtg_old")
        model.link = "https://meet.google.com/xyz-abcd-efg"
        _ = await model.send { _, _, id in ids.append(id); return .sent(botId: "b", noteId: "n") }
        XCTAssertEqual(ids, ["id-1", "id-1", "id-2"])
    }

    func testARefusalWithoutASentence_orNoConnection_saysSoPlainly() async {
        let model = SendNotetakerModel(makeId: { "id" })
        model.link = "https://meet.google.com/abc-defg-hij"
        model.agreed = true
        _ = await model.send { _, _, _ in throw APIError.http(status: 500, message: "internal") }
        XCTAssertEqual(model.error, "The notetaker wasn't sent. Please try again.")
        _ = await model.send { _, _, _ in throw URLError(.notConnectedToInternet) }
        XCTAssertEqual(model.error, "The notetaker wasn't sent. Check your connection and try again.")
    }

    func testTheSwitchComesFromTheServer_andAnOlderServerMeansOff() async {
        let defaults = UserDefaults(suiteName: "notetaker-switch-\(UUID().uuidString)")!
        let switches = AppSwitches(defaults: defaults)
        XCTAssertFalse(switches.notetakerBot)
        await switches.refresh { AppConfigResponse(broadcastCapture: false, notetaker: .init(bot: true)) }
        XCTAssertTrue(switches.notetakerBot)
        XCTAssertTrue(AppSwitches(defaults: defaults).notetakerBot, "the last answer is kept for an offline launch")
        await switches.refresh { AppConfigResponse(broadcastCapture: false) }
        XCTAssertFalse(switches.notetakerBot)
        let decoded = try? JSONDecoder().decode(AppConfigResponse.self, from: Data(#"{"broadcastCapture":true,"notetaker":{"bot":true,"calendar":false,"zoomImport":false,"extension":false}}"#.utf8))
        XCTAssertEqual(decoded?.notetaker?.bot, true)
    }
}

/// The api's answers to sending the notetaker, and renaming a speaker in place.
final class NotetakerAPIAndRenameTests: XCTestCase {
    private var api: APIClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.recorded = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        api = APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    private func respond(_ json: String, status: Int = 200) {
        StubURLProtocol.responder = { _ in (status, Data(json.utf8)) }
    }

    func testCreateMeetingBotMapsEachAnswer() async throws {
        respond(#"{"botId":"b1","noteId":"mtg_new","status":"requested"}"#)
        let sent = try await api.createMeetingBot(meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Sync", requestId: "r1")
        XCTAssertEqual(sent, .sent(botId: "b1", noteId: "mtg_new"))
        // By its path: another test's analytics can land in the same stub meanwhile.
        let last = try XCTUnwrap(StubURLProtocol.recorded.last(where: { $0.url.path == "/v1/meetings/bots" }))
        XCTAssertEqual(last.body?["meetingUrl"] as? String, "https://meet.google.com/abc-defg-hij")
        XCTAssertEqual(last.body?["title"] as? String, "Sync")
        XCTAssertEqual(last.body?["requestId"] as? String, "r1")

        respond(#"{"error":"A notetaker is already on its way to this meeting.","botId":"b0","noteId":"mtg_old"}"#, status: 409)
        let again = try await api.createMeetingBot(meetingUrl: "https://meet.google.com/abc-defg-hij", title: nil, requestId: "r2")
        XCTAssertEqual(again, .alreadyOnItsWay(noteId: "mtg_old"))
        XCTAssertNil(StubURLProtocol.recorded.last(where: { $0.url.path == "/v1/meetings/bots" })?.body?["title"])

        respond(#"{"error":"quota_exceeded","message":"You've used this month's notetaker minutes."}"#, status: 402)
        do {
            _ = try await api.createMeetingBot(meetingUrl: "https://meet.google.com/abc-defg-hij", title: nil, requestId: "r3")
            XCTFail("expected a refusal")
        } catch APIError.http(let status, let message) {
            XCTAssertEqual(status, 402)
            XCTAssertEqual(message, "You've used this month's notetaker minutes.")
        }
    }

    @MainActor
    func testRenamingASpeakerRelabelsTheirLinesAtOnce_andTheFullTranscriptWinsWhenItHasSpeakers() async throws {
        respond(#"""
        {"transcript":{"lines":[
          {"id":"1","speaker":"Alice","speakerTag":1,"startMs":0,"endMs":1000,"text":"Hello."},
          {"id":"2","speaker":"Speaker 2","speakerTag":2,"startMs":1000,"endMs":2000,"text":"Hi."},
          {"id":"3","speaker":"Alice","speakerTag":1,"startMs":2000,"endMs":3000,"text":"Shall we?"}
        ],"totalLines":3,"nextCursor":null}}
        """#)
        let repo = TranscriptRepository(api: api)
        repo.loadFull(noteId: "n1", workspaceId: "w")
        for _ in 0..<50 where repo.state == .loading { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(repo.state, .loaded(totalLines: 3))
        // The mirror has as many lines but no speaker tags: the fetched lines are the ones shown (renamable).
        let mirrored = [TranscriptLine(index: 0, speaker: "Alice", text: "Hello.", time: "0:00"),
                        TranscriptLine(index: 1, speaker: "Speaker 2", text: "Hi.", time: "0:01"),
                        TranscriptLine(index: 2, speaker: "Alice", text: "Shall we?", time: "0:02")]
        XCTAssertEqual(repo.displayLines(mirrored: mirrored, for: "n1").map(\.speakerTag), [1, 2, 1])

        repo.renameSpeaker(tag: 2, to: "Bob", noteId: "n1")
        XCTAssertEqual(repo.lines.map(\.speaker), ["Alice", "Bob", "Alice"])
        repo.renameSpeaker(tag: 1, to: "", noteId: "n1")
        XCTAssertEqual(repo.lines.map(\.speaker), ["Speaker 1", "Bob", "Speaker 1"])
        repo.renameSpeaker(tag: 2, to: "Eve", noteId: "another-note")
        XCTAssertEqual(repo.lines.map(\.speaker), ["Speaker 1", "Bob", "Speaker 1"])
    }

    func testAShortMirrorWithoutSpeakersStillWinsOverAnEqualFetchWithout() {
        let a = [TranscriptLine(index: 0, speaker: "", text: "Hello.", time: "0:00")]
        XCTAssertEqual(TranscriptRepository.preferred(full: a, fullNoteId: "n1", mirrored: a, noteId: "n1").first?.speakerTag, nil)
        var tagged = a
        tagged[0].speakerTag = 1
        XCTAssertEqual(TranscriptRepository.preferred(full: tagged, fullNoteId: "n1", mirrored: a, noteId: "n1").first?.speakerTag, 1)
        XCTAssertEqual(TranscriptRepository.preferred(full: tagged, fullNoteId: "other", mirrored: a, noteId: "n1").first?.speakerTag, nil)
    }
}
