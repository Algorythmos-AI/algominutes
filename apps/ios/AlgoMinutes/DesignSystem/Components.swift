import SwiftUI

// MARK: - Card

/// Elevation levels — applied by component, never ad hoc. At most ONE hero
/// card per screen; lists sit flat so feature cards can pop.
enum OwllCardStyle {
    /// List rows, settings cells: plain surface + hairline, no shadow.
    case flat
    /// Feature cards: gradient fill + soft shadow.
    case raised
    /// The screen's signature card: raised + top shimmer + deeper shadow.
    case hero
}

struct OwllCard<Content: View>: View {
    var style: OwllCardStyle = .raised
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .shadow(
                color: shadowColor,
                radius: style == .flat ? 0 : 12,
                y: style == .flat ? 0 : 6
            )
    }

    @ViewBuilder private var background: some View {
        let shape = RoundedRectangle(cornerRadius: Theme.Radius.lg)
        switch style {
        case .flat:
            shape
                .fill(Theme.surface)
                .overlay(shape.strokeBorder(Theme.borderSoft, lineWidth: 1))
        case .raised, .hero:
            shape
                .fill(
                    LinearGradient(
                        colors: [Theme.surfaceElevated, Theme.card],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(shape.strokeBorder(Theme.borderSoft, lineWidth: 1))
                .overlay(alignment: .top) {
                    if style == .hero {
                        // Top-edge shimmer (brand rule: hero only).
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.35), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(height: 1)
                        .padding(.horizontal, Theme.Spacing.xxl)
                    }
                }
        }
    }

    private var shadowColor: Color {
        switch style {
        case .flat: return .clear
        case .raised: return .black.opacity(0.5)
        case .hero: return .black.opacity(0.65)
        }
    }
}

// MARK: - Button styles

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.label(16))
            .foregroundStyle(Theme.onInverse)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(Theme.inverse)
            )
            .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    var tint: Color = Theme.body

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typography.label(15))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.borderSoft, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// Shared press feedback for tappable cards: subtle scale + dim + a light
/// haptic on press-down only. Full-width cards need a smaller relative scale
/// than buttons (0.98, not 0.97) to feel physical rather than cartoonish.
struct CardButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.75), value: configuration.isPressed)
            // Two-arg trigger: haptic on press-down only, not again on release.
            .sensoryFeedback(.impact(weight: .light), trigger: configuration.isPressed) { _, pressed in
                pressed
            }
    }
}

// MARK: - Motion

/// Skeleton shimmer for in-progress content. Static highlight under Reduce Motion.
struct ShimmerModifier: ViewModifier {
    /// Lets a caller keep the modifier attached while toggling the effect,
    /// so the view's identity does not change when it starts or stops —
    /// swapping modifiers on and off would rebuild the subtree instead.
    var active: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay(
                GeometryReader { geo in
                    if reduceMotion {
                        Color.white.opacity(0.04)
                    } else {
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.06), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: phase * geo.size.width * 1.6)
                        .onAppear {
                            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                                phase = 1
                            }
                        }
                    }
                }
                .allowsHitTesting(false)
                .opacity(active ? 1 : 0)
            )
            .clipped()
    }
}

extension View {
    func shimmer(active: Bool = true) -> some View { modifier(ShimmerModifier(active: active)) }
}

/// Staggered entrance: fade + 8pt rise, ~180ms total across three sections.
/// Renders final state immediately under Reduce Motion.
struct AppearFade: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let index: Int
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .onAppear {
                withAnimation(.easeOut(duration: 0.35).delay(Double(index) * 0.06)) {
                    shown = true
                }
            }
    }
}

extension View {
    func appearFade(index: Int) -> some View { modifier(AppearFade(index: index)) }
}

// MARK: - Status badge (monochrome: shape + motion carry meaning, not color)

struct StatusBadge: View {
    let status: NoteStatus
    var progress: NoteProgress?
    var errorMessage: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if status == .error {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.heading)
            } else {
                Circle()
                    .fill(status.isInProgress ? Theme.outline : Theme.muted)
                    .frame(width: 8, height: 8)
                    .opacity(status.isInProgress && pulsing && !reduceMotion ? 0.35 : 1)
                    .animation(
                        status.isInProgress
                            ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                            : .default,
                        value: pulsing
                    )
            }
            Text(status.label)
                .font(Typography.label(12))
                .foregroundStyle(status == .error ? Theme.heading : Theme.body)
            if status == .transcribing, let p = progress, p.total > 0 {
                Text("\(p.done)/\(p.total)")
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.muted)
            }
            if status == .error, let message = errorMessage, !message.isEmpty {
                Text(message)
                    .font(Typography.body(12))
                    .foregroundStyle(Theme.body)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(Theme.surface)
                .overlay(Capsule().strokeBorder(
                    status == .error ? Theme.tertiary : Theme.borderSoft,
                    lineWidth: 1
                ))
        )
        .onAppear { pulsing = true }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(status.label)")
    }
}

// MARK: - Consent checkbox

struct ConsentCheckbox: View {
    @Binding var isChecked: Bool
    let text: String

    var body: some View {
        Button {
            isChecked.toggle()
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 22))
                    .foregroundStyle(isChecked ? Theme.heading : Theme.muted)
                Text(text)
                    .font(Typography.body(14))
                    .foregroundStyle(Theme.body)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isChecked ? [.isSelected] : [])
    }
}

// MARK: - Empty state

struct EmptyStateView: View {
    let icon: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.08))
                    .frame(width: 72, height: 72)
                Image(systemName: icon)
                    .font(.system(size: 30))
                    .foregroundStyle(Theme.outline)
            }
            Text(message)
                .font(Typography.body(14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(maxWidth: 220)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 44)
        .padding(.horizontal, Theme.Spacing.xxl)
    }
}

// MARK: - Background mesh (port of .owll-bg)

struct OwllBackground: View {
    var body: some View {
        ZStack {
            Theme.background
            RadialGradient(
                colors: [Color.white.opacity(0.05), .clear],
                center: .init(x: 0.85, y: 0.05),
                startRadius: 10,
                endRadius: 380
            )
            RadialGradient(
                colors: [Color.white.opacity(0.03), .clear],
                center: .init(x: 0.1, y: 0.85),
                startRadius: 10,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }
}
