# AlgoMinutes brand kit

The "ai" mark (a speech-bubble "a" and an "i") in white, on a rich purple tile of the Algorythmos gradient.
Everything here is **generated** from `packages/tokens/tokens.json` and the measured geometry, and the decision
is recorded in `docs/DECISIONS.md` (2026-09-27). Don't edit the outputs by hand. Change a token or the geometry,
then regenerate.

```bash
swift brand/scripts/generate.swift     # icons, logos, the iOS app icon, web and site icons (macOS)
node brand/scripts/social.mjs          # logo PNGs, social images, og.png, the reveal videos
```

`social.mjs` needs `npm ci` at the root (Playwright comes with `apps/site`) and `ffmpeg` for the videos
(`--no-video` skips them). The generator's iOS renditions need Xcode 26 (`ictool`); without it, they're skipped.

## What's where

| Folder | What | Use it for |
|---|---|---|
| `icon/` | `icon-rounded.svg` and `icon.svg`: the tile. `app-icon-1024.png` (square), `icon-rounded-1024.png` | Presentations, docs, store art |
| `icon/ios-*.png` | iOS 26's own renders of the app icon: `light`, `dark`, `clear-*` and `tinted-*` | Showing the real home-screen icon |
| `logo/` | `mark-*`, `wordmark-*`, `lockup-*` as SVG (text as outlines), plus `png/` | Anything with the name on it |
| `social/` | Link preview, X header, LinkedIn banner and cover, YouTube banner, avatar, `brand-reveal-*.mp4` | Profiles and posts |
| `motion/` | `mark-animated.svg`: the tile with a light sweep and a listening pulse | Site hero, loading states |
| `fonts/` | Geist Regular, Medium, SemiBold, Bold, with `OFL.txt` | Brand type (the logos don't need it) |
| `reference/` | The owner's original artwork (2026-09-26) | Provenance |
| `scripts/` | `generate.swift` and `social.mjs` | Regenerating everything |

The app icon itself is `apps/ios/AlgoMinutes/Resources/AppIcon.icon`, an Icon Composer document:
- **Layers:** the tile (`background.png`, `background-dark.png`), and the glyph and the dot, each on its own plane.
- **The mark is white glass, with translucency off.** iOS 26 adds its specular light and depth, and the mark
  stays solid white.
- **How it renders:** Xcode 26 flattens the same file for iOS 17–25 and the App Store.
- **The fallback:** `Assets.xcassets/AppIcon.appiconset` holds the same icon, flattened by the same recipe, for
  an Xcode before 26 (which can't read `.icon`).

## The logos

| File | What |
|---|---|
| `lockup-*` | **The primary logo**: the mark and the wordmark, side by side |
| `lockup-endorsed-*` | The same, with "BY ALGORYTHMOS" under the wordmark |
| `lockup-stacked-*` | The mark above the wordmark, for square spaces |
| `lockup-tile-*` | The app icon and the wordmark, for marketing on dark or light |
| `wordmark-*` | "Algo" (Geist Medium) and "Minutes" (Geist Bold) |
| `mark-*` | The mark alone |

Every file comes in `on-dark` and `on-light`. The mark, the wordmark and the lockup also come in `mono-white` and
`mono-black`:
- **On dark:** a white "Algo" and mark (dot included), and lavender "Minutes".
- **On light:** an ink "Algo", with the mark and "Minutes" in the brand gradient, and a violet dot.
- **Mono:** one colour, for single-ink print, embossing and busy photos.

**Clear space.** The files are trimmed to the artwork. Keep a clear space around the logo equal to the height of
the "i" dot at the size you use it, and add it yourself.

**Minimum sizes.**
- The mark: 16 px.
- The lockup: 96 px wide.
- The endorsed lockup: 160 px wide, so the byline stays legible.
- Below 64 px the app icon uses a solid white glyph (the favicons do this already).

**Don't:**
- recolour the mark outside the colourways;
- stretch it, rotate it, or outline it;
- put the tile on a busy photo without a dark scrim;
- set the wordmark in another typeface;
- put the flat violet mark on the violet gradient.

## Colour

| Colour | Hex | RGB | Token |
|---|---|---|---|
| Algorythmos blue | `#3715E0` | 55, 21, 224 | `brand.algorythmos.blue` (`mark.gradientStart`) |
| Algorythmos violet | `#6D00FF` | 109, 0, 255 | `brand.algorythmos.violet` (`mark.gradientEnd`) |
| Algorythmos purple | `#7658E7` | 118, 88, 231 | `brand.algorythmos.purple` |
| Aurora magenta | `#C04BFF` | 192, 75, 255 | `mark.auroraMagenta` |
| Lift | `#9A6BFF` | 154, 107, 255 | `mark.lift` |
| Deep space | `#07051A` | 7, 5, 26 | `mark.space` |
| Navy | `#120C33` | 18, 12, 51 | `mark.navy` |
| Ink | `#1B1440` | 27, 20, 64 | `mark.ink` |
| Lavender | `#C9BEFF` | 201, 190, 255 | `mark.lavender` |
| Dot | `#D9D1FF` | 217, 209, 255 | `mark.dot` |
| Byline grey | `#6B6880` | 107, 104, 128 | `mark.byline` |

**The gradient** runs blue → violet at 45°, top-left to bottom-right.

**Contrast** (checked by `tests/brand-assets.test.ts`):
- `lavender` on the app's dark background is AA for text.
- White on the brand blue is AA for a filled control's label.
- The brand blue itself is **not** a text colour on dark.

## Type

**Geist** (Vercel; SIL Open Font Licence, `fonts/OFL.txt`).

| Weight | Where |
|---|---|
| Bold | "Minutes" |
| Medium | "Algo" |
| SemiBold | Headlines, the byline |
| Regular | Body copy |

- Headlines are tracked in by −2%.
- The byline is caps, tracked out by +34%.

## The look

**The icon.** A white mark on a rich purple tile: the contrast carries it at every size.
- **Tile.** The official blue → violet diagonal. It's lifted with a soft `lift` violet glow behind the mark,
  darker at the foot, and lit from the top-left.
- **Mark.** The glyph and the dot are one white material, with the faintest `glyphShade` at the foot for form.
  They're raised on a soft shadow that never shows through them.
- **Contrast.** White on both ends of the gradient is AA, and the tests check it.

**Marketing art** (social images, videos, hero sections): deep space around the icon.
- **Aurora.** A `space` base with soft blooms of blue from the top-left, violet from the bottom-right, and
  `auroraMagenta` on the right.
- **Waveform.** A voice line that swells in the middle, drawn in the gradient with a glow. It's the secondary
  motif (minutes are voice). Keep it behind content and clear of text.
- **Grid.** A 40 px grid at 5% white, faded out at the edges.
- **Chips.** Glass pills (7% white fill, 18% white border) for labels like "BY ALGORYTHMOS".
- **Motion.** A light sweeps the tile behind the mark. The dot "listens": it breathes, and a ring leaves it.

## Size of the mark in the app icon

The mark is scaled ×1.75 and centred, so it fills 85% of the tile's height, with 76 px above and below in a
1024 tile. The dot and the bubble's tail stay more than 48 px inside the rounded corners. `mark.json` records
the layout, and the tests hold these as invariants, so the icon can't quietly shrink again. Maskable web icons
use ×1.2, so Android's circular crop keeps the whole mark.

## Geometry (1024 tile, y down, before layout)

Measured from the 224 px tile in `reference/icon-sizes.png`, scaled by 1024/224.

| Part | Shape |
|---|---|
| Bowl | circle, centre (486.9, 566.9), r 171.4 |
| Counter | circle, centre (493.7, 566.9), r 73.1 |
| Stem | rect, x 592.0–674.3, y 413.7–738.3; flush with the bowl's base |
| Tail | triangle (346.5, 667.4), (404.6, 720.0), (306.3, 756.6) |
| Dot | circle, centre (649.1, 310.9), r 52.6 |
| Rounded tile | corner radius 229 (the web and documents; iOS masks its own icon) |

The glyph is one outline: bowl ∪ stem ∪ tail, minus the counter (CoreGraphics boolean operations).
