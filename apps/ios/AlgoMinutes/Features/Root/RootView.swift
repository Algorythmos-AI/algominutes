import SwiftUI

struct RootView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase
    /// A6.3: whether we've tried to establish the default anonymous identity, so
    /// the login fallback only appears if that genuinely failed.
    @State private var didAttemptGuest = false

    var body: some View {
        @Bindable var env = env
        @Bindable var billing = env.billing
        Group {
            if env.auth.user != nil {
                MainTabView()
            } else if !didAttemptGuest || env.auth.isSigningIn {
                // A6.3: bring up the anonymous guest identity before showing any
                // account UI, so the very first session can record + summarize
                // with no sign-in. LoginView is only the fallback if anon fails.
                BootstrapSplash()
            } else {
                LoginView()
            }
        }
        .task {
            if env.auth.user == nil, !didAttemptGuest {
                await env.auth.ensureAnonymousIdentity()
                didAttemptGuest = true
            }
        }
        // A9.5 paywall — presented from billing state (quota hit, metered gate,
        // trial banner, Settings), never at launch.
        .sheet(isPresented: $billing.isPaywallPresented) {
            PaywallView()
                .environment(env)
                .algoMinutesSheet([.large])
        }
        // A6.3 account prompt — presented after the first summary, never at launch.
        .sheet(isPresented: $billing.isAccountPromptPresented) {
            AccountUpgradeSheet(onSeePlans: { env.billing.presentPaywall(.firstSummary) })
                .environment(env)
                .algoMinutesSheet([.large])
        }
        // The api answered 426: this build is too old to talk to it.
        .fullScreenCover(isPresented: Binding(get: { env.updateRequired }, set: { _ in })) {
            UpdateRequiredView()
        }
        .background(AlgoMinutesBackground())
        // Support Dynamic Type broadly, but clamp the largest accessibility
        // sizes so the fixed-layout recording screen doesn't overflow.
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .onChange(of: env.auth.user?.uid) { _, uid in
            if uid != nil {
                env.startSession()
            } else {
                env.endSession()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Uploads killed while backgrounded resume from disk on return.
            if phase == .active, env.auth.user != nil {
                Task { await env.resumePendingUploads() }
                // A capture of another app ends while that app is in front.
                Task { await env.claimBroadcastCapture() }
                // Re-read entitlement: a subscription may have changed in the
                // system Settings while we were backgrounded.
                Task { await env.billing.refresh() }
                // A switch may have been flipped (broadcast's kill switch).
                Task { await env.refreshSwitches() }
            }
        }
        // A capture started from Control Center skipped the app's consent step:
        // it isn't uploaded until the user confirms, the same as in the app.
        .confirmationDialog(
            "Turn your capture into a note?",
            isPresented: Binding(
                get: { env.isBroadcastConsentPending },
                set: { if !$0 { env.isBroadcastConsentPending = false } }
            ),
            titleVisibility: .visible
        ) {
            Button("I have permission") { Task { await env.confirmBroadcastConsent() } }
            Button("Discard the capture", role: .destructive) { env.discardBroadcastCapture() }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("Confirm you have permission from everyone whose voice was captured. If others were present, let them know it was recorded.")
        }
        .alert("AlgoMinutes", isPresented: Binding(
            get: { env.alertMessage != nil },
            set: { if !$0 { env.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(env.alertMessage ?? "")
        }
    }
}

/// Minimal launch gate shown while the anonymous guest identity is being
/// established (A6.3). Brief; no account UI here by design.
struct BootstrapSplash: View {
    var body: some View {
        ZStack {
            AlgoMinutesBackground()
            VStack(spacing: Theme.Spacing.lg) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 96)
                    .accessibilityHidden(true)
                ProgressView().tint(Theme.heading)
            }
        }
    }
}

struct MainTabView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(DeepLinkRouter.self) private var deepLinkRouter
    @State private var selectedTab = 0

    init() {
        // Stock TabView chrome reads as "default app" — restyle via appearance
        // proxy instead of a custom bar (which would re-implement keyboard
        // avoidance, safe areas, and scroll-edge transitions for no gain).
        let appearance = UITabBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundColor = UIColor(white: 0, alpha: 0.85)
        appearance.backgroundEffect = UIBlurEffect(style: .systemChromeMaterialDark)
        // Hairline top border.
        appearance.shadowColor = UIColor(white: 1, alpha: 0.08)
        let item = appearance.stackedLayoutAppearance
        item.normal.iconColor = UIColor(Theme.muted)
        item.normal.titleTextAttributes = [.foregroundColor: UIColor(Theme.muted)]
        item.selected.iconColor = UIColor(Theme.heading)
        item.selected.titleTextAttributes = [.foregroundColor: UIColor(Theme.heading)]
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "waveform") }
                .tag(0)
            FilesView()
                .tabItem { Label("Files", systemImage: "folder") }
                .tag(1)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(2)
        }
        .sensoryFeedback(.selection, trigger: selectedTab)
        // A tapped push (or an algominutes://note link) opens its note on Home,
        // whichever tab the user was on: HomeView does the navigation.
        .onChange(of: deepLinkRouter.arrivals) { selectedTab = 0 }
    }
}
