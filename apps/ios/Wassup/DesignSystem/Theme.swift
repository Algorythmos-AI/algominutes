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

/// Pure monochrome greyscale tokens (brand palette, no accent hue).
/// Status is communicated through shape, motion, and iconography — never color.
/// Contrast rules: `muted` (#929393) is the floor for meaningful text;
/// `tertiary` (#6A6B6B) is decorative/disabled only (fails AA on charcoal).
enum Theme {
    static let background = Color(hex: 0x000000)
    static let recordingBackground = Color(hex: 0x000000)
    static let surface = Color(hex: 0x232425)
    static let surfaceElevated = Color(hex: 0x4B4C4B)
    static let card = Color(hex: 0x232425)

    /// Filled controls invert: white fill, black content.
    static let inverse = Color(hex: 0xFFFFFF)
    static let onInverse = Color(hex: 0x000000)

    static let border = Color(hex: 0x4B4C4B)
    static let borderSoft = Color.white.opacity(0.10)

    static let heading = Color.white
    static let body = Color(hex: 0xDEDDDE)
    static let muted = Color(hex: 0x929393)
    static let tertiary = Color(hex: 0x6A6B6B)

    /// Chip outlines, waveform bars, idle secondary strokes.
    static let outline = Color(hex: 0xBCBCBC)

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
    /// Brand fonts fail SILENTLY into the system fallback if unregistered —
    /// exactly how the original Saira config shipped rendering nothing.
    static func assertBrandFontsLoaded() {
        for name in ["Rajdhani-Medium", "Rajdhani-SemiBold", "Rajdhani-Bold"] {
            assert(UIFont(name: name, size: 12) != nil,
                   "Brand font \(name) not registered — check UIAppFonts + Resources/Fonts")
        }
    }
    #endif
}

/// Rajdhani for brand voice (headings/labels), SF for reading (body) and
/// numerals (timer — Rajdhani's digits aren't tabular and would jitter).
/// TTFs are committed under Resources/Fonts; scripts/fetch-fonts.sh regenerates.
///
/// Every token scales with Dynamic Type: custom fonts use `relativeTo:`, and
/// the system fallback scales the design size through `UIFontMetrics`. The
/// numeric sizes stay as the design baseline at the default text size.
enum Typography {
    // MARK: Semantic scale

    /// Greeting name, screen titles.
    static func display() -> Font { heading(30) }

    /// Hero card title.
    static func title() -> Font { heading(18) }

    /// Row / card titles.
    static func headline() -> Font { heading(15) }

    /// Uppercase section labels. Apply `.tracking(1.4)` + uppercase at call site.
    static func eyebrow(_ size: CGFloat = 12) -> Font {
        scaled("Rajdhani-Medium", size: size, weight: .medium, relativeTo: .caption)
    }

    // MARK: Base faces

    static func heading(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        scaled("Rajdhani-Bold", size: size, weight: weight, relativeTo: .title2)
    }

    static func label(_ size: CGFloat) -> Font {
        scaled("Rajdhani-SemiBold", size: size, weight: .semibold, relativeTo: .subheadline)
    }

    /// Running text stays on SF — tuned for iOS at small sizes; the web's body
    /// face is Titillium (not Rajdhani), so there is no parity to chase.
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
        _ name: String, size: CGFloat, weight: Font.Weight,
        relativeTo textStyle: Font.TextStyle, design: Font.Design = .default
    ) -> Font {
        if UIFont(name: name, size: size) != nil {
            return .custom(name, size: size, relativeTo: textStyle)
        }
        // System fallback: scale the design size to the user's text-size setting
        // so it still honors Dynamic Type.
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
