# AlgoMinutes brand assets

The "ai" mark: a speech-bubble "a" and an "i", on a violet gradient tile.

## Source of truth

- **`reference/`**: the owner's artwork, as supplied (2026-09-26).
  - `icon-sizes.png`: the tile at four sizes.
  - `wordmark-dark.png`: the wordmark on navy.
  - `wordmark-light.png`: the wordmark on white.
- **Colours**: `packages/tokens/tokens.json` → `brand.mark`, sampled from `reference/` (below).
- **Geometry**: measured from `reference/icon-sizes.png` (below), and kept in
  `apps/ios/scripts/generate-app-icon.swift` (`Mark`).

Everything else here is **generated**. Don't edit it; change the tokens or the geometry and run:

```bash
cd apps/ios && swift scripts/generate-app-icon.swift
```

That writes:

- the app icons (`AppIcon-1024.png` opaque, plus `-dark` and `-tinted`);
- the in-app logo (`Logo.imageset/logo.pdf`, a vector);
- `icon.svg`, `icon-rounded.svg`, `mark-on-dark.svg` and `mark-on-light.svg` here.

## Colours (sampled from `reference/`)

| Token (`brand.mark.*`) | Value | Where it was sampled |
|---|---|---|
| `gradientStart` | `#3716DF` | The tile's diagonal gradient, extrapolated to its top-left corner. Samples at 14% and 89% along the diagonal: `#3E19E2`, `#5121E9` (both off-diagonal corners) and `#642AF0`. It's also the light wordmark's "Minutes" and mark colour exactly (`#3716DF`, 5,247 px). |
| `gradientEnd` | `#6A2DF2` | The same gradient, extrapolated to its bottom-right corner. |
| `glyph` | `#FFFFFF` | The "a" and stem. |
| `dot` | `#D9D1FF` | The "i" dot on the tile (396 px). |
| `dotOnLight` | `#6C32F0` | The dot on the light wordmark. |
| `navy` | `#120C33` | The dark wordmark's background. |
| `ink` | `#1B1440` | "Algo" on the light wordmark. |
| `lavender` | `#C9BEFF` | "Minutes" on the dark wordmark. |
| `byline` | `#6B6880` | "BY ALGORYTHMOS" on the light wordmark. |

**Contrast** (checked by `tests/brand-assets.test.ts`):

- `lavender` on the app's dark background is AA for text.
- White on `gradientStart` is AA for a filled control's label.
- `gradientStart` itself is **not** for text on dark (2.2:1).

## Geometry (in a 1024 tile, y down)

These are measured from the 224 px tile in `reference/icon-sizes.png`, scaled by 1024/224.

| Part | Shape |
|---|---|
| Bowl | circle, centre (486.9, 566.9), r 171.4 |
| Counter | circle, centre (493.7, 566.9), r 73.1 |
| Stem | rect, x 592.0–674.3, y 413.7–738.3; flush with the bowl's base |
| Tail | triangle (346.5, 667.4), (404.6, 720.0), (306.3, 756.6) |
| Dot | circle, centre (649.1, 310.9), r 52.6 |
| Rounded tile | corner radius 229 (the web and documents; iOS masks its own icon) |

Checked against the reference at 224 px:

- colours match within 1/255 at seven points (the four gradient corners, the counter, the dot, the glyph);
- the glyph's pixels overlap 95.9%, with the bounding boxes within 1 px.

## Wordmark

The wordmark ("Algo" + "Minutes", a geometric sans like Poppins SemiBold) is kept as reference art for
now. A vector version needs the font's outlines, and comes with the public site.
