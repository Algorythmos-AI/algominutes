import SwiftUI

struct RootView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var env = env
        Group {
            if env.auth.user != nil {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .background(OwllBackground())
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
            }
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

struct MainTabView: View {
    @Environment(AppEnvironment.self) private var env
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
    }
}
