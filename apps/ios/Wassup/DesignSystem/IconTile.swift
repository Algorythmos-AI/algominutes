import SwiftUI

/// A square icon-over-label button, used in tile rows.
///
/// Extracted from the private `tile(_:icon:action:)` in `MoreOperationsSheet`
/// when the quick-action row became the second caller — a third copy is where
/// tile styling starts drifting between sheets, which is the drift the design
/// system exists to stop.
///
/// Disabled tiles stay visible rather than disappearing: a row that changes
/// length depending on note state is harder to learn than one where a tile is
/// simply unavailable.
struct IconTile: View {
    let label: String
    let icon: String
    var enabled: Bool = true
    let action: () -> Void

    init(_ label: String, icon: String, enabled: Bool = true, action: @escaping () -> Void) {
        self.label = label
        self.icon = icon
        self.enabled = enabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .frame(height: 24)
                Text(label)
                    .font(Typography.label(12))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(enabled ? Theme.body : Theme.tertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.surfaceElevated)
            )
        }
        .buttonStyle(CardButtonStyle())
        .disabled(!enabled)
    }
}
