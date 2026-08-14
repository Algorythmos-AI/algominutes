import SwiftUI

/// Placeholder line for content that is still being produced.
///
/// Ragged widths on purpose — a stack of identical bars reads as a broken
/// layout, whereas uneven ones read as text that has not arrived.
struct SkeletonRow: View {
    /// Fraction of the available width, 0...1.
    var widthFraction: Double = 1
    var height: CGFloat = 13

    var body: some View {
        GeometryReader { proxy in
            Capsule()
                .fill(Theme.surfaceElevated)
                .frame(width: proxy.size.width * widthFraction, height: height)
        }
        .frame(height: height)
    }
}

/// A block of skeleton rows standing in for a transcript.
///
/// One `.shimmer()` on the container rather than per row: the modifier drives
/// its own animation clock, and inside a lazy stack each row would restart
/// that clock as it recycled, so the block would twinkle instead of sweep.
/// It is already Reduce-Motion aware.
struct SkeletonBlock: View {
    var rows: [Double] = [0.92, 0.78, 0.95, 0.64, 0.86]
    var spacing: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, fraction in
                SkeletonRow(widthFraction: fraction)
            }
        }
        .shimmer()
        .accessibilityHidden(true)
    }
}
