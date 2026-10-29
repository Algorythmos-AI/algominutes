import XCTest
@testable import AlgoMinutes

/// App Store guideline 5.1.2(i): explicit permission before sending personal data to a third-party AI. A one-time,
/// per-device agreement to send recordings and their text to Google Cloud AI, stored with the version of its
/// words, withdrawn in Settings, and checked on every path that uploads or asks the AI
/// (docs/plans/APP-STORE-REVIEW-PACKAGE.md §5).
@MainActor
final class AISharingConsentTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "ai-sharing-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        StubURLProtocol.recorded = []
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func stubbedAPI() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
    }

    // MARK: - The stored decision

    func testNothingIsAgreedOnAFreshDevice() {
        let consent = AISharingConsent(defaults: defaults)
        XCTAssertFalse(consent.isAgreed)
        XCTAssertFalse(consent.agreedToEarlierWords)
        XCTAssertNil(consent.agreedAt)
        for path in AISharingPath.allCases {
            XCTAssertFalse(consent.allows(path), path.rawValue)
        }
    }

    func testAgreeingStoresTheVersionAndWhen_andLastsAcrossLaunches() {
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        AISharingConsent(defaults: defaults).agree(at: when)
        XCTAssertEqual(defaults.integer(forKey: AISharingConsent.versionKey), AISharingConsent.version)

        // A new launch reads it back.
        let next = AISharingConsent(defaults: defaults)
        XCTAssertTrue(next.isAgreed)
        XCTAssertEqual(next.agreedAt, when)
        for path in AISharingPath.allCases {
            XCTAssertTrue(next.allows(path), path.rawValue)
        }
    }

    func testWithdrawingStopsEveryPathUntilAgreedAgain() {
        let consent = AISharingConsent(defaults: defaults)
        consent.agree()
        consent.withdraw()
        XCTAssertFalse(consent.isAgreed)
        XCTAssertNil(defaults.object(forKey: AISharingConsent.versionKey))
        XCTAssertNil(defaults.object(forKey: AISharingConsent.agreedAtKey))
        for path in AISharingPath.allCases {
            XCTAssertFalse(consent.allows(path), path.rawValue)
        }
        XCTAssertFalse(AISharingConsent(defaults: defaults).isAgreed, "the withdrawal didn't last to the next launch")

        consent.agree()
        XCTAssertTrue(consent.isAgreed)
    }

    /// Changing the words (bumping the version) asks everyone again.
    func testAnAgreementToEarlierWordsDoesNotCoverNewOnes() {
        XCTAssertFalse(AISharingConsent.covers(stored: 0, current: 1))
        XCTAssertFalse(AISharingConsent.covers(stored: 1, current: 2))
        XCTAssertTrue(AISharingConsent.covers(stored: 2, current: 2))
        // A newer build's agreement, then a downgrade: still the person's answer.
        XCTAssertTrue(AISharingConsent.covers(stored: 3, current: 2))
    }

    // MARK: - The gate the views use

    func testTheGateRunsAtOnceWhenAgreed() {
        let consent = AISharingConsent(defaults: defaults)
        consent.agree()
        var ran = 0
        let request = consent.gate(.recording) { ran += 1 }
        XCTAssertNil(request)
        XCTAssertEqual(ran, 1)
    }

    /// Not agreed: nothing runs until "Agree and continue"; "Not now" (the request dropped) runs nothing.
    func testTheGateWaitsForTheAgreement() throws {
        let consent = AISharingConsent(defaults: defaults)
        var ran = 0
        let request = try XCTUnwrap(consent.gate(.importAudio) { ran += 1 })
        XCTAssertEqual(request.path, .importAudio)
        XCTAssertEqual(ran, 0)
        consent.agree()
        request.proceed()
        XCTAssertEqual(ran, 1)
    }

    // MARK: - The words

    func testTheWordsNameGoogleCloudAndWhatIsSent() {
        XCTAssertEqual(AISharingCopy.title, "Send your recordings to Google Cloud AI?")
        XCTAssertTrue(AISharingCopy.body.contains("Google Cloud"))
        XCTAssertTrue(AISharingCopy.body.contains("Gemini"))
        XCTAssertTrue(AISharingCopy.body.contains("your audio and its text"))
        XCTAssertTrue(AISharingCopy.body.contains("scan"))
        XCTAssertTrue(AISharingCopy.body.contains("questions"))
        XCTAssertEqual(AISharingCopy.agree, "Agree and continue")
        XCTAssertEqual(AISharingCopy.notNow, "Not now")
        XCTAssertTrue(AISharingCopy.withdrawMessage.contains("until you agree again"))
        // Separate from the recording sheet's tick, which is about other people's permission.
        XCTAssertFalse(AISharingCopy.body.contains("permission"))
    }

    /// The sheet says Google doesn't train on it only because the Privacy Policy says so.
    func testTheTrainingSentenceIsWhatThePrivacyPolicySays() throws {
        XCTAssertTrue(AISharingCopy.detail.contains("doesn't use it to train"))
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let policy = repo.appendingPathComponent("apps/site/src/pages/privacy.astro")
        guard let text = try? String(contentsOf: policy, encoding: .utf8) else {
            throw XCTSkip("the Privacy Policy source isn't readable from this test host")
        }
        XCTAssertTrue(text.contains("don't allow them to use it to train"),
                      "the Privacy Policy no longer says the providers can't train on it: drop the sentence from AISharingCopy.detail")
    }

    // MARK: - Every path checks it

    func testRecordingAndImportAskBeforeTheirSheetOpens_scanAsksWhenItSaves() {
        XCTAssertEqual(CaptureAction.recording.aiSharingPath, .recording)
        XCTAssertEqual(CaptureAction.importFiles.aiSharingPath, .importAudio)
        // Scan Text also makes PDFs, which never leave the phone: it asks when it saves a note.
        XCTAssertNil(CaptureAction.scanText.aiSharingPath)
    }

    /// A capture of another app (started from Control Center, outside the app) isn't uploaded without the
    /// agreement; it's asked for before the permission, and the switch still holds it first.
    func testACaptureOfAnotherAppWaitsForTheAgreement() {
        XCTAssertEqual(BroadcastHandoff.decide(hasFinishedCapture: true, switchOn: true, aiSharingAgreed: false, consented: true), .askAISharing)
        XCTAssertEqual(BroadcastHandoff.decide(hasFinishedCapture: true, switchOn: true, aiSharingAgreed: false, consented: false), .askAISharing)
        XCTAssertEqual(BroadcastHandoff.decide(hasFinishedCapture: true, switchOn: false, aiSharingAgreed: false, consented: true), .hold)
        XCTAssertEqual(BroadcastHandoff.decide(hasFinishedCapture: true, switchOn: true, aiSharingAgreed: true, consented: false), .askConsent)
        XCTAssertEqual(BroadcastHandoff.decide(hasFinishedCapture: true, switchOn: true, aiSharingAgreed: true, consented: true), .claim)
    }

    func testAScanIsNotSentWithoutTheAgreement() async {
        StubURLProtocol.responder = { _ in (200, Data(#"{"noteId":"n1","status":"ready"}"#.utf8)) }
        let note = PendingTextNote(workspaceId: "workspace_u", text: "Receipt", source: .scannedImage, title: nil, noteId: "n1")
        let outcome = await TextNoteSave.save(note, api: stubbedAPI(), aiSharingAgreed: false)
        XCTAssertEqual(outcome, .notAgreed)
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty, "a request left the phone")
    }

    func testAQuestionIsNotSentWithoutTheAgreement_andItsDraftIsKept() async {
        StubURLProtocol.responder = { _ in (200, Data("event: done\ndata: {}\n\n".utf8)) }
        let vm = ChatViewModel()
        vm.aiSharingAllowed = { false }
        vm.attach(api: stubbedAPI())
        vm.draft = "what did we decide?"
        vm.send()
        XCTAssertEqual(vm.draft, "what did we decide?")
        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertFalse(vm.isStreaming)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty, "a question left the phone")
    }

    func testTheNotetakerIsNotSentWithoutTheAgreement() async {
        let model = SendNotetakerModel(makeId: { "id-1" }, aiSharingAllowed: { false })
        model.link = "meet.google.com/abc-defg-hij"
        model.agreed = true
        var calls = 0
        let noteId = await model.send { _, _, _ in calls += 1; return .sent(botId: "b", noteId: "n") }
        XCTAssertNil(noteId)
        XCTAssertEqual(calls, 0)
    }

    func testASummaryIsNotRewrittenWithoutTheAgreement() async {
        let vm = NoteDetailViewModel()
        vm.aiSharingAllowed = { false }
        var failure: String?
        vm.regenerate(.general, noteId: "n1", workspaceId: "workspace_u", api: stubbedAPI()) { failure = $0 }
        XCTAssertEqual(failure, AISharingCopy.blocked)
        XCTAssertFalse(vm.isRegenerating)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty, "a rewrite left the phone")
    }

    /// The unit tests launch the app without the flag: the agreement is left as it is.
    func testTheResetFlagIsOffWithoutItsArgument() {
        XCTAssertFalse(UITestHooks.resetAISharing)
    }

    // MARK: - The sheet

    func testTheSheetsButtonsDoWhatTheySay() {
        var agreed = 0
        var declined = 0
        let sheet = AISharingConsentSheet(onAgree: { agreed += 1 }, onNotNow: { declined += 1 })
        sheet.onAgree()
        XCTAssertEqual(agreed, 1)
        sheet.onNotNow()
        XCTAssertEqual(declined, 1)
        _ = sheet.body
    }
}
