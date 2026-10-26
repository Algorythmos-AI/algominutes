import XCTest
@testable import AlgoMinutes

// MARK: - The account prompt comes after the first summary is read (RELEASE.md rev 11, H16)
//
// It used to go up the moment the summary was on screen, over the first note a guest had made.

@MainActor
final class AccountPromptAfterReadingTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "account-prompt-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func billing() -> BillingService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let api = APIClient(session: URLSession(configuration: config), idToken: { "test-token" })
        return BillingService(api: api, paywallEnabled: false, defaults: defaults)
    }

    func testAGuestIsNotAskedOverTheSummaryButWhenTheyLeaveItAndOnlyOnce() {
        let b = billing()
        b.onFirstSummaryViewed(isGuest: true)
        XCTAssertFalse(b.isAccountPromptPresented)

        b.onLeftNote(isGuest: true)
        XCTAssertTrue(b.isAccountPromptPresented)

        b.isAccountPromptPresented = false
        b.onFirstSummaryViewed(isGuest: true)
        b.onLeftNote(isGuest: true)
        XCTAssertFalse(b.isAccountPromptPresented)
    }

    func testLeavingANoteBeforeAnySummaryAsksNothing() {
        let b = billing()
        b.onLeftNote(isGuest: true)
        XCTAssertFalse(b.isAccountPromptPresented)
    }

    func testAnAppClosedOnTheSummaryStillAsksTheNextTimeANoteIsLeft() {
        billing().onFirstSummaryViewed(isGuest: true)
        let relaunched = billing()
        XCTAssertFalse(relaunched.isAccountPromptPresented)
        relaunched.onLeftNote(isGuest: true)
        XCTAssertTrue(relaunched.isAccountPromptPresented)
    }

    func testSomeoneWhoMadeAnAccountInTheMeantimeIsNotAsked() {
        let b = billing()
        b.onFirstSummaryViewed(isGuest: true)
        b.onLeftNote(isGuest: false)
        XCTAssertFalse(b.isAccountPromptPresented)
        b.onLeftNote(isGuest: true)
        XCTAssertFalse(b.isAccountPromptPresented)
    }

    func testAnAccountHolderIsNeverOwedThePrompt() {
        let b = billing()
        b.onFirstSummaryViewed(isGuest: false)
        b.onLeftNote(isGuest: true)
        XCTAssertFalse(b.isAccountPromptPresented)
    }
}
