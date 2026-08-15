// TODO(brand A6.5): provisional palette — final hue/typeface pending brand sign-off.
// Values below mirror packages/tokens/tokens.json (single source of truth):
// color.dark.* ramp + brand.* indigo accent. The prior client greyscale/Rajdhani
// theme has been replaced. See apps/web/src/index.css and the Compose theme for parity.

import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// AlgoMinutes dark palette (tokens.json `color.dark.*`) plus the brand indigo
/// accent (`brand.*`). Contrast rules: `body`/`heading` are AA on the dark
/// surfaces; `muted` (#8A8D9C) is the floor for meaningful text; `placeholder`/
/// `tertiary` (#5A5D6E) is decorative/disabled only.
enum Theme {
    static let background = Color(hex: 0x0B0B10)          // color.dark.bg
    static let recordingBackground = Color(hex: 0x0B0B10) // color.dark.bg
    static let surface = Color(hex: 0x16161F)             // color.dark.surface
    static let surfaceElevated = Color(hex: 0x1C1C27)     // color.dark.cardHover
    static let card = Color(hex: 0x14141C)                // color.dark.card

    /// Brand accent (tokens.json `brand.*`). Available for on-brand controls;
    /// filled accent controls put `onAccent` content on `accent`.
    static let accent = Color(hex: 0x5B67F0)
    static let accentHover = Color(hex: 0x454FD6)
    static let accentActive = Color(hex: 0x3A43BE)
    static let onAccent = Color(hex: 0xFFFFFF)

    /// Filled controls invert: white fill, dark content.
    static let inverse = Color(hex: 0xFFFFFF)
    static let onInverse = Color(hex: 0x0B0B10)

    static let border = Color(hex: 0x2A2A38)             // color.dark.border
    static let borderSoft = Color.white.opacity(0.08)    // color.dark.borderSoft

    static let heading = Color(hex: 0xF5F6FA)            // color.dark.heading
    static let body = Color(hex: 0xC8CAD6)               // color.dark.body
    static let muted = Color(hex: 0x8A8D9C)              // color.dark.muted
    static let tertiary = Color(hex: 0x5A5D6E)           // color.dark.placeholder

    /// Status colours (tokens.json `color.status.*`).
    static let success = Color(hex: 0x22C55E)
    static let warning = Color(hex: 0xF5B841)
    static let danger = Color(hex: 0xEF4444)
    static let info = Color(hex: 0x5B67F0)

    /// Chip outlines, waveform bars, idle secondary strokes.
    static let outline = Color(hex: 0x8A8D9C)

    /// 4pt spacing grid. Use these instead of literals so rhythm stays consistent.
    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
        static let xxxl: CGFloat = 32
    }

    enum Radius {
        /// Chips, small icon tiles.
        static let sm: CGFloat = 10
        /// Buttons, hero icon tiles.
        static let md: CGFloat = 16
        /// Cards.
        static let lg: CGFloat = 20
        /// Sheets.
        static let xl: CGFloat = 28
    }

    #if DEBUG
    /// TODO(brand A6.5): provisional typeface. The client brand fonts (Rajdhani)
    /// were dropped; Typography now uses the system font (tokens.json
    /// `typography.fontFamily` system stack). No custom-font registration to
    /// assert until the final AlgoMinutes typeface is chosen. Kept as a no-op so
    /// existing call sites (AlgoMinutesApp) still compile.
    static func assertBrandFontsLoaded() {}
    #endif
}

/// Type scale from tokens.json `typography.scale`. Sizes/weights match the
/// shared tokens (also applied on web and Compose).
///
/// TODO(brand A6.5): provisional typeface. The client brand font (Rajdhani) was
/// dropped; every face now uses the system font (tokens.json
/// `typography.fontFamily` system stack). Every token still scales with Dynamic
/// Type: the design size is scaled through `UIFontMetrics` relative to the
/// matching text style.
enum Typography {
    // MARK: Semantic scale (tokens.json typography.scale)

    /// Greeting name, screen titles. scale.display — 34 / 700.
    static func display() -> Font { heading(34, weight: .bold) }

    /// Hero card title. scale.title2 — 22 / 600.
    static func title() -> Font { heading(22, weight: .semibold) }

    /// Row / card titles. scale.headline — 16 / 600.
    static func headline() -> Font { label(16) }

    /// Uppercase section labels. Apply `.tracking(1.4)` + uppercase at call site.
    /// scale.caption — 12 / 500.
    static func eyebrow(_ size: CGFloat = 12) -> Font {
        scaled(size: size, weight: .medium, relativeTo: .caption)
    }

    // MARK: Base faces

    /// Bold headings. Weight defaults to .bold (scale.display/title1 = 700);
    /// pass .semibold for scale.title2/title3 (= 600).
    static func heading(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        scaled(size: size, weight: weight, relativeTo: .title2)
    }

    /// Semibold labels. scale.title3/headline weight (= 600).
    static func label(_ size: CGFloat) -> Font {
        scaled(size: size, weight: .semibold, relativeTo: .subheadline)
    }

    /// Running text. scale.body — 15 / 400.
    static func body(_ size: CGFloat = 15) -> Font {
        let scaledSize = UIFontMetrics(forTextStyle: .body).scaledValue(for: size)
        return .system(size: scaledSize, weight: .regular)
    }

    /// Timers need tabular digits: SF rounded + monospacedDigit at call site.
    static func timer(_ size: CGFloat) -> Font {
        let scaledSize = UIFontMetrics(forTextStyle: .largeTitle).scaledValue(for: size)
        return .system(size: scaledSize, weight: .bold, design: .rounded)
    }

    private static func scaled(
        size: CGFloat, weight: Font.Weight,
        relativeTo textStyle: Font.TextStyle, design: Font.Design = .default
    ) -> Font {
        // System font, scaled to the user's text-size setting so it honors
        // Dynamic Type. (No custom brand font until A6.5 final typeface.)
        let scaledSize = UIFontMetrics(forTextStyle: textStyle.uiTextStyle).scaledValue(for: size)
        return .system(size: scaledSize, weight: weight, design: design)
    }
}

private extension Font.TextStyle {
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .body: return .body
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        @unknown default: return .body
        }
    }
}
