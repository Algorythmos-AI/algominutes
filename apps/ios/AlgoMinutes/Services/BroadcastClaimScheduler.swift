import Foundation

/// When the app looks for a capture the broadcast extension finished, and in what order.
///
/// A capture ends while another app is in front, so the app looks whenever it comes back, and also when a session
/// starts: a cold launch begins already active, so "came back" alone never fired and a finished capture waited,
/// unclaimed, with no question asked (device run 2026-10-29). Each pass refreshes the server's switches FIRST and
/// decides after: run side by side, the decision could read the switch before the answer arrived. (Before any answer
/// ever, it's off by design; after one, the last answer is kept, offline too.) A trigger that comes while a pass runs
/// isn't lost or run twice at once: one more pass follows.
@MainActor
final class BroadcastClaimScheduler {
    enum Trigger: String {
        /// A signed-in session started: a cold launch, a sign-in.
        case sessionStarted
        /// The app came back to the foreground.
        case becameActive
    }

    private let refreshSwitches: () async -> Void
    private let claim: () async -> Void
    private var running: Task<Void, Never>?
    private var again = false

    init(refreshSwitches: @escaping () async -> Void, claim: @escaping () async -> Void) {
        self.refreshSwitches = refreshSwitches
        self.claim = claim
    }

    /// Refresh the switches, then claim. Returns the pass that will cover this trigger.
    @discardableResult
    func trigger(_ why: Trigger) -> Task<Void, Never> {
        AppLog.info("broadcast_claim_trigger reason=\(why.rawValue) running=\(running != nil)")
        if let running {
            again = true
            return running
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.again = false
                await self.refreshSwitches()
                await self.claim()
            } while self.again
            self.running = nil
        }
        running = task
        return task
    }
}
