// Ambient audio-equalizer backdrop for the home screen.
//
// A full-width row of segmented bars pinned to the bottom of the viewport that
// rise and fall on independent rhythms — a purely decorative background element
// (pointer-events: none, aria-hidden). Animation is pure CSS (GPU transform),
// so React never re-renders per frame. Respects prefers-reduced-motion via CSS.

const BAR_COUNT = 36;

// Deterministic pseudo-random (seeded by index) so the pattern is stable across
// renders/hydration but still looks organic — no two adjacent bars in sync.
function seeded(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x); // 0..1
}

export default function EqualizerBg() {
  return (
    <div className="owll-eq" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const variant = 1 + Math.floor(seeded(i, 1) * 8); // 1–8 jagged patterns
        const dur = 2.4 + seeded(i, 3) * 2.8;              // cycle 2.4–5.2s (slow)
        const delay = -seeded(i, 4) * 5;                   // desync starts
        return (
          <span
            key={i}
            className="owll-eq__bar"
            style={{
              animationName: `owll-eq-j${variant}`,
              animationDuration: `${dur.toFixed(2)}s`,
              animationDelay: `${delay.toFixed(2)}s`,
            }}
          />
        );
      })}
    </div>
  );
}
