import SwiftUI

/// A ring split into one arc per pipeline stage.
///
/// Completed stages are solid, the active stage either sweeps or fills to a
/// measured fraction, and stages ahead are hollow. Monochrome throughout —
/// state reads from shape and motion, never hue (Theme has no status colours
/// by design).
///
/// The stage segments are what make this honest: they always convey real
/// position, so the ring is informative even when no percentage exists.
struct ProgressRing: View {
    let stage: NoteProcessingStage
    var diameter: CGFloat = 76
    var lineWidth: CGFloat = 5

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweeping = false

    private var totalSegments: Int { NoteProcessingStage.Phase.allCases.count - 1 }
    private var segmentSpan: Double { 1.0 / Double(totalSegments) }
    /// Gap between arcs. Wide enough that the ring reads as *four stages*
    /// rather than one circle — at 0.02 the separation was invisible at
    /// 76pt and the whole point of segmenting was lost.
    private var gap: Double { 0.055 }

    var body: some View {
        ZStack {
            ForEach(0..<totalSegments, id: \.self) { index in
                segment(index)
            }
            detailText
        }
        .frame(width: diameter, height: diameter)
        .rotationEffect(.degrees(-90))     // start at 12 o'clock
        .animation(.easeInOut(duration: 0.35), value: stage)
        .onAppear { if !reduceMotion { sweeping = true } }
        .accessibilityElement()
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private func segment(_ index: Int) -> some View {
        let start = Double(index) * segmentSpan + gap / 2
        let end = Double(index + 1) * segmentSpan - gap / 2

        // Track for every segment, so the ring is a full circle even at step one.
        Circle()
            .trim(from: start, to: end)
            .stroke(Theme.border, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))

        if index < stage.completedPhases {
            Circle()
                .trim(from: start, to: end)
                .stroke(Theme.outline, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        } else if index == stage.completedPhases {
            activeSegment(start: start, end: end)
        }
    }

    @ViewBuilder
    private func activeSegment(start: Double, end: Double) -> some View {
        switch stage.fill {
        case .fraction(let value):
            Circle()
                .trim(from: start, to: start + (end - start) * max(0, min(1, value)))
                .stroke(Theme.heading, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        case .indeterminate:
            // A short arc chasing around the active segment. Under Reduce
            // Motion it parks at a quarter — still visibly "this stage is
            // live" without the animation.
            let span = (end - start)
            let head = reduceMotion ? 0.25 : (sweeping ? 0.75 : 0.05)
            Circle()
                .trim(from: start, to: start + span * head)
                .stroke(Theme.heading, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .animation(
                    reduceMotion
                        ? nil
                        : .easeInOut(duration: 1.1).repeatForever(autoreverses: true),
                    value: sweeping
                )
        }
    }

    @ViewBuilder
    private var detailText: some View {
        if let detail = stage.detail {
            Text(detail)
                .font(Typography.timer(15))
                .monospacedDigit()
                .foregroundStyle(Theme.heading)
                .rotationEffect(.degrees(90))   // undo the ring's rotation
        }
    }

    private var accessibilityText: String {
        if let detail = stage.detail { return "\(stage.label), \(detail)" }
        return stage.label
    }
}
