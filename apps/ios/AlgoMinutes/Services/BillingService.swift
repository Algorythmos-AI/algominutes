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

    /// The beta's way to minutes (docs/plans/RELEASE.md PR 8): an invite code.
    /// With the paywall off it's what a quota hit, or a recording with no
    /// minutes left, opens; Settings opens it too.
    var isInviteSheetPresented = false

    private let api: APIClient
    private let defaults: UserDefaults
    /// PAYWALL_ENABLED for this build; injectable so tests can try both.
    private let paywallEnabled: Bool

    init(api: APIClient, paywallEnabled: Bool = AppConfig.paywallEnabled, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults
        self.paywallEnabled = paywallEnabled
        self.store = StoreKitService(api: api)
        // When StoreKit forwards a verified receipt, re-read the authoritative
        // entitlement and note the purchase in the funnel.
        store.onEntitlementMayHaveChanged = { [weak self] in
            guard let self else { return }
            // A purchase is the entitlement becoming a subscription. A grant was
            // `active` already, and isn't one (RELEASE.md PR 26b).
            let wasSubscribed = self.entitlement?.isSubscription == true
            await self.refresh()
            if !wasSubscribed, self.entitlement?.isSubscription == true {
                await self.track(.purchase)
            }
        }
    }

    // MARK: - Entitlement

    /// Re-read the entitlement from the server. Safe to call often.
    func refresh() async {
        do {
            let previous = entitlement
            let next = try await api.fetchEntitlement()
            entitlement = next
            // A9.6 `cancellation`: a lapse out of a subscription or the trial into
            // the free floor (or expiry) is the funnel's churn signal. A grant
            // running out isn't. Best-effort — the server's webhook is the
            // authoritative cancellation record.
            if let previous, previous.isSubscription || previous.state == .trialing,
               next.state == .expired || next.state == .freeFloor {
                await track(.cancellation, props: ["from": previous.state.rawValue])
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

    /// No minutes left right now, by the server's count. Unknown (not fetched
    /// yet) or unmetered counts as having minutes, so a slow network never
    /// blocks anyone.
    var hasNoMinutesLeft: Bool {
        guard let remaining = entitlement?.remainingMinutes else { return false }
        return remaining <= 0
    }

    /// Gate helper for metered call sites. If allowed, returns true. If gated,
    /// presents the paywall (or, with no paywall, the invite code sheet) and
    /// returns false so the caller aborts.
    func guardMeteredAction() -> Bool {
        if !paywallEnabled {
            // No products on sale: an invite code is the way to minutes. Ask for
            // it before a recording the server would refuse, rather than after
            // the meeting. Otherwise the server decides.
            if hasNoMinutesLeft {
                presentInviteSheet()
                return false
            }
            return true
        }
        if canStartMeteredAction { return true }
        presentPaywall(.meteredGate)
        return false
    }

    func presentInviteSheet() {
        isInviteSheetPresented = true
    }

    /// Set while the paywall closes to make way for the invite code sheet: one
    /// sheet can't present while another is still dismissing, so the paywall's
    /// `onDismiss` opens it (`paywallDismissed()`).
    private(set) var inviteAfterPaywall = false

    /// From a paywall with nothing to sell (no products in App Store Connect yet,
    /// or the App Store unreachable) to the beta's other way to minutes, an
    /// invite code (RELEASE.md PR 27), rather than a dead end.
    func switchToInviteSheet() {
        inviteAfterPaywall = true
        isPaywallPresented = false
    }

    /// The paywall sheet's `onDismiss`.
    func paywallDismissed() {
        guard inviteAfterPaywall else { return }
        inviteAfterPaywall = false
        presentInviteSheet()
    }

    // MARK: - Pre-purchase check

    /// Whether a purchase may start. StoreKit buys on the device, where the server
    /// can't refuse it, and a store's charge can't be refunded from our side, so
    /// the entitlement is read again first: anyone already subscribed, on any
    /// store, isn't sold a second subscription (RELEASE.md PR 26b's check, on iOS).
    /// A grant or the trial isn't a subscription, and can buy.
    enum PurchaseGate: Equatable {
        case allowed
        /// Managed in the App Store (so the paywall offers Manage), or billed on the web.
        case alreadySubscribed(managedInAppStore: Bool)
    }

    func purchaseGate() async -> PurchaseGate {
        await refresh()
        guard let e = entitlement, e.isSubscription else { return .allowed }
        // The event only: which store bills them is the entitlement's, and stays off the device log
        // (CodeQL swift/cleartext-logging); the server logs its own refusal with the rail.
        AppLog.info("purchase_refused_subscribed")
        return .alreadySubscribed(managedInAppStore: e.isManagedInAppStore)
    }

    /// Redeem an invite code; the entitlement it produced becomes the current
    /// one. Throws the api's error (see `APIClient.redeemInvite`).
    @discardableResult
    func redeemInvite(_ code: String) async throws -> RedeemInviteResponse {
        let result = try await api.redeemInvite(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
        entitlement = result.entitlement
        return result
    }

    // MARK: - Paywall / prompt triggers

    func presentPaywall(_ context: PaywallContext) {
        guard paywallEnabled else {
            AppLog.info("paywall_suppressed context=\(context.rawValue)")
            return
        }
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
    /// The guest has seen their first summary and has not yet been asked to make an account.
    /// Kept across launches: an app closed on the summary still asks, the next time a note is left.
    static let accountPromptOwedKey = "account_prompt.owed_after_first_summary"

    /// Fires `first_summary_viewed` once, then, NOT at launch, owes a still-anonymous
    /// guest the A6.3 account prompt, or presents the paywall if the user is already
    /// past the trial. During the trial we never hard-sell.
    ///
    /// The prompt used to go up here, the moment the summary was on screen: over the
    /// first note anyone had made, before they had read a word of it. It now waits
    /// until they leave the note (`onLeftNote`; RELEASE.md rev 11, H16).
    func onFirstSummaryViewed(isGuest: Bool) {
        let firstTime = fireOnce(.firstSummaryViewed, key: "analytics.first_summary_viewed")
        guard firstTime else { return }
        if isGuest {
            // Convert the guest to a permanent account first (A6.3). The sheet
            // itself links onward to Pro plans.
            defaults.set(true, forKey: Self.accountPromptOwedKey)
        } else if entitlement?.gatesMeteredActions == true {
            // Already past the reverse trial: surface the paywall now.
            presentPaywall(.firstSummary)
        }
    }

    /// The note screen has gone: ask the guest who has read their first summary to make
    /// an account, once. Someone who made an account in the meantime is not asked.
    func onLeftNote(isGuest: Bool) {
        guard defaults.bool(forKey: Self.accountPromptOwedKey) else { return }
        defaults.removeObject(forKey: Self.accountPromptOwedKey)
        if isGuest { isAccountPromptPresented = true }
    }

    /// Called when the server refuses a metered action (402 quota_exceeded).
    /// `entitlement` is the server's state from the 402 body, so the paywall
    /// shows the real usage without another round trip.
    func onQuotaExceeded(entitlement: EntitlementResponse? = nil) {
        if let entitlement { self.entitlement = entitlement }
        Task { await track(.quotaHit) }
        // With no paywall, the invite code sheet is where minutes come from.
        if paywallEnabled { presentPaywall(.quotaHit) } else { presentInviteSheet() }
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
