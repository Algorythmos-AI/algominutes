import XCTest
@testable import AlgoMinutes

// MARK: - Readable secondary text (RELEASE.md rev 11, H19)
//
// `muted` is the floor for text someone is meant to read; `tertiary` is for
// decoration and disabled controls only. Legal links, dates, section labels and
// fine print were set in `tertiary`, at about 2.6:1.

final class ThemeContrastTests: XCTestCase {
    func testMutedTextIsReadableOnTheLightestDarkSurface() {
        // 4.5:1 is WCAG AA for body text. The elevated surface is the lightest one text sits on.
        XCTAssertGreaterThanOrEqual(Theme.contrastRatio(Theme.Hex.muted, Theme.Hex.surfaceElevated), 4.5)
    }

    func testTertiaryIsNotAndSoIsNotForText() {
        XCTAssertLessThan(Theme.contrastRatio(Theme.Hex.tertiary, Theme.Hex.surfaceElevated), 4.5)
    }

    func testTheRatioIsTheWCAGOne() {
        XCTAssertEqual(Theme.contrastRatio(0x000000, 0xFFFFFF), 21, accuracy: 0.01)
        XCTAssertEqual(Theme.contrastRatio(0x777777, 0x777777), 1, accuracy: 0.001)
    }
}
