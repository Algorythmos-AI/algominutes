import Foundation

/// Billing coordinator (A9.4/A9.5/A9.6 + A6.3 placement). The single object the
/// UI binds to for: the server-resolved entitlement, StoreKit products/purchase
/// (via `StoreKitService`), paywall presentation, the post-summary account
/// prompt, and the analytics funnel.
///
/// Entitlement is read from the server, never inferred on-device — `store`
/// forwards receipts, the server grants, and `refresh()` reads the result.
@Observable
@MainActor
final class BillingService {
    let store: StoreKitService

    /// Server truth. `nil` until the first `refresh()`; treat unknown as
    /// "don't gate" so a slow network never blocks a legitimately-entitled user.
    private(set) var entitlement: EntitlementResponse?

    // MARK: Paywall presentation

    /// Why the paywall is showing — drives its headline and which analytics
    /// props accompany `paywall_viewed`.
    enum PaywallContext: String {
        case firstSummary   // shown after the first summary once past the trial
        case quotaHit       // server returned 402 quota_exceeded
        case meteredGate    // free_floor/expired user tried a metered action
        case manual         // opened from Settings
    }

    var isPaywallPresented = false
    private(set) var paywallContext: PaywallContext = .manual

    /// A6.3: the guest→permanent account prompt, presented AFTER the first
    /// summary — never at launch.
    var isAccountPromptPresented = false

    private let api: APIClient
    private let defaults = UserDefaults.standard

    init(api: APIClient) {
        self.api = api
        self.store = StoreKitService(api: api)
        // When StoreKit forwards a verified receipt, re-read the authoritative
        // entitlement and note the purchase in the funnel.
        store.onEntitlementMayHaveChanged = { [weak self] in
            guard let self else { return }
            let wasActive = self.entitlement?.state == .active
            await self.refresh()
            if !wasActive, self.entitlement?.state == .active {
                await self.track(.purchase)
            }
        }
    }

    // MARK: - Entitlement

    /// Re-read the entitlement from the server. Safe to call often.
    func refresh() async {
        do {
            let previous = entitlement?.state
            let next = try await api.fetchEntitlement()
            entitlement = next
            // A9.6 `cancellation`: a lapse out of a paid/trial state into the
            // free floor (or expiry) is the funnel's churn signal. Best-effort —
            // the server's webhook is the authoritative cancellation record.
            if let previous, previous == .active || previous == .trialing,
               next.state == .expired || next.state == .freeFloor {
                await track(.cancellation, props: ["from": previous.rawValue])
            }
        } catch {
            // TODO(A9-infra): endpoint not live yet — leave prior value in place
            // and stay in the permissive "unknown" state rather than gating.
            AppLog.error("entitlement_refresh_failed: \(error.localizedDescription)")
        }
    }

    /// Load products + entitlement + re-confirm any existing purchases. Called
    /// once the user identity is available.
    func bootstrap() async {
        await store.loadProducts()
        await refresh()
        // Re-confirm entitlements bought on another device without finishing
        // them (they're finished when first purchased on their origin device).
        await store.syncCurrentEntitlements(finishOnServerOK: false)
    }

    // MARK: - Gating (A9.3 free floor)

    /// Whether a metered action (new recording / import) is allowed right now.
    /// Trial and active never gate; free_floor/expired do. Unknown = allow.
    var canStartMeteredAction: Bool {
        entitlement?.gatesMeteredActions != true
    }

    var isTrialing: Bool { entitlement?.state == .trialing }
    var trialDaysRemaining: Int? { entitlement?.trialDaysRemaining }

    /// Gate helper for metered call sites. If allowed, returns true. If gated,
    /// presents the paywall and returns false so the caller aborts.
    func guardMeteredAction() -> Bool {
        if canStartMeteredAction { return true }
        presentPaywall(.meteredGate)
        return false
    }

    // MARK: - Paywall / prompt triggers

    func presentPaywall(_ context: PaywallContext) {
        paywallContext = context
        isPaywallPresented = true
        Task { await track(.paywallViewed, props: ["context": context.rawValue]) }
    }

    // MARK: - Placement hooks (A9.6 funnel + A6.3 prompt)

    /// A9.6 `first_recording` — fired once per install when capture first starts.
    func onFirstRecordingStarted() {
        fireOnce(.firstRecording, key: "analytics.first_recording")
    }

    /// Called when a note's summary is first shown (NoteDetailView, ready state).
    /// Fires `first_summary_viewed` once, then — NOT at launch — presents the
    /// A6.3 account prompt to a still-anonymous guest, or the paywall if the
    /// user is already past the trial. During the trial we never hard-sell.
    func onFirstSummaryViewed(isGuest: Bool) {
        let firstTime = fireOnce(.firstSummaryViewed, key: "analytics.first_summary_viewed")
        guard firstTime else { return }
        if isGuest {
            // Convert the guest to a permanent account first (A6.3). The sheet
            // itself links onward to Pro plans.
            isAccountPromptPresented = true
        } else if entitlement?.gatesMeteredActions == true {
            // Already past the reverse trial: surface the paywall now.
            presentPaywall(.firstSummary)
        }
    }

    /// Called when the server refuses a metered action (402 quota_exceeded).
    /// `entitlement` is the server's state from the 402 body, so the paywall
    /// shows the real usage without another round trip.
    func onQuotaExceeded(entitlement: EntitlementResponse? = nil) {
        if let entitlement { self.entitlement = entitlement }
        Task { await track(.quotaHit) }
        presentPaywall(.quotaHit)
    }

    // MARK: - Analytics

    /// Best-effort funnel event. Never throws into the caller.
    func track(_ event: AnalyticsEvent, props: [String: Any]? = nil) async {
        try? await api.track(event: event, props: props)
    }

    /// Emit `event` at most once per install. Returns true if this call is the
    /// one that fired it.
    @discardableResult
    private func fireOnce(_ event: AnalyticsEvent, key: String) -> Bool {
        guard !defaults.bool(forKey: key) else { return false }
        defaults.set(true, forKey: key)
        Task { await track(event) }
        return true
    }
}
