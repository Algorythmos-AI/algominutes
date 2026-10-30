import XCTest
@testable import AlgoMinutes

/// 2026-10-29: a 51 s capture finished (state "finished", file in the App Group), the app was opened from cold, and
/// nothing asked to make it a note. The claim ran only on a change of scene phase, which a cold launch (already
/// active) never makes, and beside a switch refresh it could outrun. BroadcastClaimScheduler (AppEnvironment's
/// startSession and RootView's return to the foreground) refreshes the switches, then decides.
@MainActor
final class BroadcastClaimSchedulerTests: XCTestCase {
    private struct Offline: Error {}
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "BroadcastClaimSchedulerTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    /// What a pass decided for a finished capture with the AI agreement given and no consent yet this session:
    /// "ask consent" when the switch is on, "hold" when it's off.
    private final class Recorder {
        var events: [String] = []
        var decisions: [BroadcastHandoff.ClaimDecision] = []
    }

    private func scheduler(_ switches: AppSwitches, _ recorder: Recorder,
                           fetch: @escaping () async throws -> AppConfigResponse) -> BroadcastClaimScheduler {
        BroadcastClaimScheduler(
            refreshSwitches: {
                recorder.events.append("refresh")
                await switches.refresh(fetch: fetch)
            },
            claim: {
                recorder.events.append("claim")
                recorder.decisions.append(BroadcastHandoff.decide(
                    hasFinishedCapture: true, switchOn: switches.broadcastCapture, aiSharingAgreed: true, consented: false))
            }
        )
    }

    /// A cold launch: the session starts with the app already active. The capture is looked for, after the switches.
    func testAColdLaunchClaimsAfterTheSwitchesAreRefreshed() async {
        let switches = AppSwitches(defaults: defaults)
        let recorder = Recorder()
        await scheduler(switches, recorder, fetch: { AppConfigResponse(broadcastCapture: true) })
            .trigger(.sessionStarted).value
        XCTAssertEqual(recorder.events, ["refresh", "claim"])
        XCTAssertEqual(recorder.decisions, [.askConsent])
    }

    /// The app comes back to the foreground: the same pass.
    func testAWarmReturnClaimsAfterTheSwitchesAreRefreshed() async {
        let switches = AppSwitches(defaults: defaults)
        let recorder = Recorder()
        let claims = scheduler(switches, recorder, fetch: { AppConfigResponse(broadcastCapture: true) })
        await claims.trigger(.sessionStarted).value
        await claims.trigger(.becameActive).value
        XCTAssertEqual(recorder.events, ["refresh", "claim", "refresh", "claim"])
        XCTAssertEqual(recorder.decisions, [.askConsent, .askConsent])
    }

    /// The switches haven't loaded yet (a first launch: off until the server answers) and the answer is slow: the
    /// decision waits for it, instead of holding the capture on the default.
    func testTheDecisionWaitsForSwitchesNotYetLoaded() async {
        let switches = AppSwitches(defaults: defaults)
        XCTAssertFalse(switches.broadcastCapture)
        let recorder = Recorder()
        await scheduler(switches, recorder, fetch: {
            try await Task.sleep(nanoseconds: 300_000_000)
            return AppConfigResponse(broadcastCapture: true)
        }).trigger(.sessionStarted).value
        XCTAssertEqual(recorder.decisions, [.askConsent], "decided on the default before the switches arrived")
    }

    /// Offline at launch: the last answer the server gave is used, not "off".
    func testOfflineTheLastKnownSwitchIsUsed() async {
        await AppSwitches(defaults: defaults).refresh { AppConfigResponse(broadcastCapture: true) }
        let relaunched = AppSwitches(defaults: defaults)
        let recorder = Recorder()
        await scheduler(relaunched, recorder, fetch: { throw Offline() }).trigger(.sessionStarted).value
        XCTAssertEqual(recorder.decisions, [.askConsent])
    }

    /// The switch really is off: held, as before.
    func testASwitchTurnedOffStillHolds() async {
        let switches = AppSwitches(defaults: defaults)
        let recorder = Recorder()
        await scheduler(switches, recorder, fetch: { AppConfigResponse(broadcastCapture: false) })
            .trigger(.sessionStarted).value
        XCTAssertEqual(recorder.decisions, [.hold])
    }

    /// Holds the first refresh until the test opens it, so triggers land while a pass is running.
    private final class Gate {
        private var waiter: CheckedContinuation<Void, Never>?
        private(set) var isOpen = false
        var onFirstWait: (() -> Void)?
        func wait() async {
            guard !isOpen else { return }
            onFirstWait?()
            await withCheckedContinuation { waiter = $0 }
        }
        func open() {
            isOpen = true
            waiter?.resume()
            waiter = nil
        }
    }

    /// A cold launch fires both the session's start and the return to the foreground: never two passes at once, and
    /// triggers that come while a pass is running get exactly one more pass after it. (Triggers that come before a
    /// pass has begun are covered by that pass: it hasn't read anything yet.)
    func testTriggersDuringAPassAreCoalescedNotRunTwiceAtOnce() async {
        let switches = AppSwitches(defaults: defaults)
        let recorder = Recorder()
        let gate = Gate()
        let inPass = expectation(description: "the first pass is refreshing")
        gate.onFirstWait = { inPass.fulfill() }
        let claims = scheduler(switches, recorder, fetch: {
            await gate.wait()
            return AppConfigResponse(broadcastCapture: true)
        })
        let first = claims.trigger(.sessionStarted)
        await fulfillment(of: [inPass], timeout: 5)
        XCTAssertEqual(recorder.events, ["refresh"])
        let second = claims.trigger(.becameActive)
        let third = claims.trigger(.becameActive)
        gate.open()
        await first.value
        await second.value
        await third.value
        XCTAssertEqual(recorder.events, ["refresh", "claim", "refresh", "claim"])
        XCTAssertEqual(recorder.decisions, [.askConsent, .askConsent])
        // A later trigger starts a new pass.
        await claims.trigger(.becameActive).value
        XCTAssertEqual(recorder.events.count, 6)
    }
}
