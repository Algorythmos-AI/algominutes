import SwiftUI

/// Covers the app once the api answers 426 (this build is below its minimum,
/// services/api client-version.js). Nothing else can reach the server, so
/// there is no way past it but the update.
struct UpdateRequiredView: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            OwllBackground()
            VStack(spacing: Theme.Spacing.lg) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 72)
                    .accessibilityHidden(true)
                Text("Update AlgoMinutes")
                    .font(Typography.title())
                    .foregroundStyle(Theme.heading)
                Text("This version is no longer supported. Update to keep recording and reading your notes. Your recordings are safe.")
                    .font(Typography.body())
                    .foregroundStyle(Theme.body)
                    .multilineTextAlignment(.center)
                if let url = AppConfig.updateURL {
                    Button("Update") { openURL(url) }
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, Theme.Spacing.sm)
                }
            }
            .padding(Theme.Spacing.xxl)
        }
        .interactiveDismissDisabled()
    }
}
