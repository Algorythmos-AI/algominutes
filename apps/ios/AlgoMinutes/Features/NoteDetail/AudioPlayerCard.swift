import SwiftUI

/// Transport for the note's audio: skip back 5, play/pause, skip forward 5, a
/// speed pill, and a scrubber with elapsed and remaining time.
///
/// Errors render inline here rather than as alerts. "Stop recording to play
/// this note" is information about the current state, not an interruption
/// worth a modal — and a modal over a recording screen is the last thing
/// anyone mid-meeting wants.
struct AudioPlayerCard: View {
    @Environment(AppEnvironment.self) private var env
    let note: Note

    @State private var scrubbing = false
    @State private var scrubTarget: TimeInterval = 0

    private var player: AudioPlayerService { env.player }
    private var isCurrent: Bool { player.currentNoteId == note.id }
    private var elapsed: TimeInterval { scrubbing ? scrubTarget : (isCurrent ? player.currentTime : 0) }
    private var total: TimeInterval {
        isCurrent && player.duration > 0 ? player.duration : (note.duration ?? 0)
    }

    var body: some View {
        OwllCard(style: .raised) {
            VStack(spacing: Theme.Spacing.md) {
                transport
                scrubber
                if isCurrent, let error = player.error {
                    Text(error.message)
                        .font(Typography.body(12))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .task(id: note.id) { await player.load(note: note) }
        .onChange(of: note.title, initial: true) { _, title in player.nowPlayingTitle = title }
    }

    private var transport: some View {
        HStack(spacing: Theme.Spacing.xxl) {
            Spacer(minLength: 0)
            skipButton(-5, symbol: "gobackward.5")
            playButton
            skipButton(5, symbol: "goforward.5")
            Spacer(minLength: 0)
            speedPill
        }
    }

    private var playButton: some View {
        Button {
            player.togglePlayPause()
        } label: {
            ZStack {
                Circle().fill(Theme.inverse).frame(width: 52, height: 52)
                if isCurrent && player.isLoading {
                    ProgressView().tint(Theme.onInverse)
                } else {
                    Image(systemName: isCurrent && player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(Theme.onInverse)
                }
            }
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityLabel(isCurrent && player.isPlaying ? "Pause" : "Play")
    }

    private func skipButton(_ seconds: TimeInterval, symbol: String) -> some View {
        Button { player.skip(seconds) } label: {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(Theme.body)
        }
        .buttonStyle(CardButtonStyle())
        .disabled(!isCurrent)
        // 44pt hit target (tokens a11y.minTouchTargetPx) — the glyph is ~22pt.
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(seconds < 0 ? "Back 5 seconds" : "Forward 5 seconds")
    }

    private var speedPill: some View {
        Button { player.cycleSpeed() } label: {
            Text(player.speed.label)
                .font(Typography.label(12))
                .monospacedDigit()
                .foregroundStyle(Theme.body)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .overlay(Capsule().stroke(Theme.outline, lineWidth: 1))
        }
        .buttonStyle(CardButtonStyle())
        // 44pt hit target (tokens a11y.minTouchTargetPx) — the pill is shorter than 44pt.
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Playback speed \(player.speed.label)")
    }

    private var scrubber: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(
                    get: { elapsed },
                    set: { scrubTarget = $0 }
                ),
                in: 0...max(total, 1),
                onEditingChanged: { editing in
                    scrubbing = editing
                    if !editing { player.seek(to: scrubTarget) }
                }
            )
            .tint(Theme.inverse)
            .disabled(!isCurrent || total <= 0)
            // A stall is data starvation, not a hang — shimmer says "still
            // coming" where a spinner would say "stuck".
            .shimmer(active: isCurrent && player.isStalled)

            HStack {
                Text(NoteMeta.durationText(elapsed))
                Spacer()
                Text("-" + NoteMeta.durationText(max(0, total - elapsed)))
            }
            .font(Typography.body(11))
            .monospacedDigit()
            .foregroundStyle(Theme.tertiary)
        }
    }
}
