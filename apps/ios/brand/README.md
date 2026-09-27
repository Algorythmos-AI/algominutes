# AlgoMinutes brand assets

The "ai" mark: a speech-bubble "a" and an "i", in Liquid Glass on an aurora of the Algorythmos gradient
(docs/DECISIONS.md, 2026-09-27).

## Source of truth

- **`reference/`**: the owner's artwork, as supplied (2026-09-26).
  - `icon-sizes.png`: the tile at four sizes.
  - `wordmark-dark.png`: the wordmark on navy.
  - `wordmark-light.png`: the wordmark on white.
- **Colours**: `packages/tokens/tokens.json`:
  - `brand.algorythmos`: the parent brand's official colours, from its brand sheet.
  - `brand.mark`: the mark, the aurora and the glass (below).
- **Geometry**: measured from `reference/icon-sizes.png` (below), and laid out by
  `apps/ios/scripts/generate-app-icon.swift` (`Mark`, `Layout`).

Everything else is **generated**. Don't edit it; change the tokens or the geometry and run (on a Mac):

```bash
cd apps/ios && swift scripts/generate-app-icon.swift
```

That writes:

- **The app icon, `AlgoMinutes/Resources/AppIcon.icon`**, an Icon Composer document:
  - `aurora.png` and `aurora-dark.png`: the background, by appearance.
  - `glyph.svg` and `dot.svg`: in glass, on their own planes, so the dot floats above the "a".
  - iOS 26 renders it as Liquid Glass, with the system's specular light and shadows. Xcode flattens it for iOS
    17–25 and the App Store, so there's no PNG app icon to keep in step.
- **The in-app logo**, `Logo.imageset/logo.pdf` (a vector).
- **Here:**
  - `icon.svg` and `icon-rounded.svg`: the glass tile.
  - `mark-on-dark.svg` and `mark-on-light.svg`: the mark alone, flat, for UI.
  - `mark.json`: the laid-out geometry, which `tests/brand-assets.test.ts` checks.
- **The site** (`apps/site/public/`): `favicon.svg`, `favicon.ico` (16/32/48) and `apple-touch-icon.png`.
- **The web app** (`apps/web/public/`):
  - `logo.svg` and `logo.png`;
  - `favicon-16/32`;
  - `icon-48…512`;
  - `icon-maskable-192/512`;
  - `apple-touch-icon.png`.

To see the glass icon without a build, render it with Xcode's `ictool`:

```bash
"/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool" \
  AlgoMinutes/Resources/AppIcon.icon --export-image --output-file /tmp/icon.png \
  --platform iOS --rendition Default --width 1024 --height 1024 --scale 1
```

The renditions are `Default`, `Dark`, `ClearLight`, `ClearDark`, `TintedLight` and `TintedDark`.

## Size and layout

The mark is scaled **×1.75** about its bounding box (dot included) and centred in the tile.

- **Fill:** the mark is 872 of the tile's 1024 px in height (85%), with 76 px above and below.
- **Corners:** the dot and the bubble's tail stay more than 48 px inside the rounded corners.
- **Maskable web icons:** these use ×1.2, so Android's circular crop keeps the whole mark.
- **Tests:** `tests/brand-assets.test.ts` holds the size, the centring and the corner clearance, so the icon
  can't quietly shrink again.

## The look

- **Aurora.** A deep base (`auroraBase`, `#1A0A6E`) with three radial blooms:
  - `gradientStart` blue from the top-left;
  - `gradientEnd` violet from the bottom-right;
  - `auroraMagenta` on the right.

  In dark mode the base is `space` (`#07051A`), and the blooms are dimmer.
- **Glass glyph.**
  - A white fill that fades from 94% to 66% down the glyph.
  - A rim that's bright at the top, dim through the middle, and catches the light again at the bottom.
  - A soft `shadow` below it. The shadow is cleared under the glass.
- **Sphere dot.** A radial gradient from white through `#E4DCFF` to `dotShade`, lit from the top-left, with a
  glint.
- **Specular light** from the top-left over everything.
- **At 64 px and below** (favicons), the glyph is solid white, so it stays crisp.

## Colours

| Token | Value | Use |
|---|---|---|
| `algorythmos.blue` | `#3715E0` | Algorythmos gradient start; `mark.gradientStart` |
| `algorythmos.violet` | `#6D00FF` | Algorythmos gradient end; `mark.gradientEnd` |
| `algorythmos.purple` | `#7658E7` | Algorythmos secondary |
| `mark.auroraBase` | `#1A0A6E` | The tile's base, under the aurora |
| `mark.auroraMagenta` | `#C04BFF` | The aurora's right-hand bloom |
| `mark.space` | `#07051A` | The dark-mode base; deep-space backgrounds |
| `mark.shadow` | `#12024F` | The glyph's shadow |
| `mark.glyph` | `#FFFFFF` | The glyph |
| `mark.dot` | `#D9D1FF` | The "i" dot (flat); dark-mode dot |
| `mark.dotShade` | `#8B6BFF` | The dot sphere's shaded side |
| `mark.dotOnLight` | `#6C32F0` | The dot on light backgrounds |
| `mark.navy` | `#120C33` | The dark wordmark's background |
| `mark.ink` | `#1B1440` | "Algo" on the light wordmark |
| `mark.lavender` | `#C9BEFF` | "Minutes" on the dark wordmark |
| `mark.byline` | `#6B6880` | "BY ALGORYTHMOS" on the light wordmark |

**Contrast** (checked by `tests/brand-assets.test.ts`):

- `lavender` on the app's dark background is AA for text.
- White on `gradientStart` is AA for a filled control's label.
- `gradientStart` itself is **not** for text on dark.

## Geometry (in a 1024 tile, y down, before layout)

These are measured from the 224 px tile in `reference/icon-sizes.png`, scaled by 1024/224.

| Part | Shape |
|---|---|
| Bowl | circle, centre (486.9, 566.9), r 171.4 |
| Counter | circle, centre (493.7, 566.9), r 73.1 |
| Stem | rect, x 592.0–674.3, y 413.7–738.3; flush with the bowl's base |
| Tail | triangle (346.5, 667.4), (404.6, 720.0), (306.3, 756.6) |
| Dot | circle, centre (649.1, 310.9), r 52.6 |
| Rounded tile | corner radius 229 (the web and documents; iOS masks its own icon) |

The glyph is one outline: bowl ∪ stem ∪ tail, minus the counter (CoreGraphics boolean operations).

## Wordmark

The wordmark ("Algo" + "Minutes") is kept as reference art for now. The vector version, in Geist, comes
with the brand kit.
