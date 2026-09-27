import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// The brand kit brand/scripts/generate.swift and brand/scripts/social.mjs render from
// packages/tokens/tokens.json (brand.mark). Pinned here:
// - the mark's size (85% of the tile, centred, clear of the rounded corners), so
//   the icon can't quietly shrink again (docs/DECISIONS.md, 2026-09-27);
// - the official Algorythmos gradient;
// - the Liquid Glass icon's layers, and the flattened set an Xcode before 26
//   builds from (App Store validation refuses alpha on its primary);
// - the web and site icons their manifests name;
// - the kit's logos (text as outlines, every colourway) and social images;
// - the contrast rules brand/README.md states.
const GLASS = 'apps/ios/AlgoMinutes/Resources/AppIcon.icon';
const ICONS = 'apps/ios/AlgoMinutes/Resources/Assets.xcassets/AppIcon.appiconset';
const LOGO = 'apps/ios/AlgoMinutes/Resources/Assets.xcassets/Logo.imageset';
const tokens = JSON.parse(fs.readFileSync('packages/tokens/tokens.json', 'utf8'));
const mark: Record<string, string> = tokens.brand.mark;
const layout = JSON.parse(fs.readFileSync('brand/mark.json', 'utf8'));

/** A PNG's size and colour type (2 = RGB, 6 = RGB + alpha), from its IHDR chunk. */
function png(path: string) {
  const b = fs.readFileSync(path);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(b.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('the mark', () => {
  const { tile, bounds, dot, tailTip, cornerRadius } = layout;

  it('fills at least 84% of the tile', () => {
    expect(bounds.height / tile).toBeGreaterThanOrEqual(0.84);
  });

  it('is centred, top to bottom and side to side', () => {
    const top = bounds.y, bottom = tile - (bounds.y + bounds.height);
    const left = bounds.x, right = tile - (bounds.x + bounds.width);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  });

  it("keeps the dot and the bubble's tail clear of the rounded corners", () => {
    // Distance inside the corner arc; the tile's own mask can't clip them.
    const inside = (x: number, y: number, cx: number, cy: number) => cornerRadius - Math.hypot(x - cx, y - cy);
    const topRight = { cx: tile - cornerRadius, cy: cornerRadius };
    const bottomLeft = { cx: cornerRadius, cy: tile - cornerRadius };
    expect(inside(dot.cx, dot.cy, topRight.cx, topRight.cy) - dot.r).toBeGreaterThanOrEqual(48);
    expect(inside(tailTip.x, tailTip.y, bottomLeft.cx, bottomLeft.cy)).toBeGreaterThanOrEqual(48);
  });

  it('uses the official Algorythmos gradient', () => {
    expect(mark.gradientStart).toBe(tokens.brand.algorythmos.blue);
    expect(mark.gradientEnd).toBe(tokens.brand.algorythmos.violet);
  });
});

describe('Liquid Glass icon (iOS 26)', () => {
  const icon = JSON.parse(fs.readFileSync(`${GLASS}/icon.json`, 'utf8'));
  const layers = icon.groups.flatMap((g: { layers: object[] }) => g.layers);

  it('names only layer images that exist', () => {
    const images = layers.flatMap((l: { 'image-name'?: string; 'image-name-specializations'?: { value: string }[] }) =>
      [l['image-name'], ...(l['image-name-specializations'] ?? []).map((s) => s.value)].filter(Boolean));
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(fs.existsSync(`${GLASS}/Assets/${image}`), image).toBe(true);
    expect(fs.readdirSync(`${GLASS}/Assets`).sort()).toEqual([...new Set(images)].sort());
  });

  it('makes the glyph and the dot solid white glass, over an opaque tile', () => {
    const byName = Object.fromEntries(layers.map((l: { name: string }) => [l.name, l]));
    for (const name of ['glyph', 'dot']) {
      expect(byName[name].glass).toBe(true);
      expect(fs.readFileSync(`${GLASS}/Assets/${name}.svg`, 'utf8')).toContain(`fill="${mark.glyph}"`);
    }
    // Translucent glass lets the purple through, and the mark stops reading white.
    for (const g of icon.groups.filter((g: { name: string }) => g.name !== 'Background')) {
      expect(g.translucency.enabled, g.name).toBe(false);
    }
    expect(byName.background.glass).toBe(false);
    expect(png(`${GLASS}/Assets/background.png`)).toEqual({ width: 1024, height: 1024, colourType: 2 });
  });

  it('is the icon the build takes by name', () => {
    // XcodeGen adds every file under AlgoMinutes/; Xcode 26 prefers the .icon.
    expect(fs.readFileSync('apps/ios/project.yml', 'utf8')).toContain('ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon');
  });
});

describe('app icon, flattened (an Xcode before 26 builds only this)', () => {
  it('the primary icon is 1024 x 1024 with no alpha channel', () => {
    expect(png(`${ICONS}/AppIcon-1024.png`)).toEqual({ width: 1024, height: 1024, colourType: 2 });
  });

  it('the dark and tinted variants are 1024 x 1024 with alpha (iOS composites them)', () => {
    for (const v of ['dark', 'tinted']) {
      expect(png(`${ICONS}/AppIcon-1024-${v}.png`)).toEqual({ width: 1024, height: 1024, colourType: 6 });
    }
  });

  it('the asset catalog names exactly those three files', () => {
    const contents = JSON.parse(fs.readFileSync(`${ICONS}/Contents.json`, 'utf8'));
    expect(contents.images.map((i: { filename: string }) => i.filename).sort())
      .toEqual(['AppIcon-1024-dark.png', 'AppIcon-1024-tinted.png', 'AppIcon-1024.png']);
  });
});

describe('in-app logo', () => {
  it('is a vector PDF, kept as a vector', () => {
    const contents = JSON.parse(fs.readFileSync(`${LOGO}/Contents.json`, 'utf8'));
    expect(contents.images).toEqual([{ filename: 'logo.pdf', idiom: 'universal' }]);
    expect(contents.properties['preserves-vector-representation']).toBe(true);
    expect(fs.readFileSync(`${LOGO}/logo.pdf`).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(fs.readdirSync(LOGO).sort()).toEqual(['Contents.json', 'logo.pdf']);
  });

  it('carries the tile as an image (Quartz drops gradient transparency in a PDF)', () => {
    expect(fs.readFileSync(`${LOGO}/logo.pdf`).toString('latin1')).toMatch(/\/Subtype \/Image/);
  });
});

describe('brand SVGs', () => {
  const svg = (name: string) => fs.readFileSync(`brand/${name}.svg`, 'utf8');

  it("use the tokens' colours (they were generated from them, not edited)", () => {
    for (const name of ['icon/icon', 'icon/icon-rounded']) {
      const s = svg(name);
      for (const c of [mark.gradientStart, mark.gradientEnd, mark.lift, mark.glyph, mark.glyphShade]) {
        expect(s).toContain(`stop-color="${c}"`);
      }
    }
    expect(svg('logo/mark-on-dark')).toMatch(new RegExp(`<path d="[^"]+" fill="${mark.glyph}"/>`));
    // On dark, the dot is white like the glyph (the owner's dark wordmark).
    expect(svg('logo/mark-on-dark')).toMatch(new RegExp(`<circle [^>]+ fill="${mark.glyph}"/>`));
    expect(svg('logo/mark-on-light')).toContain(`stop-color="${mark.gradientStart}"`);
    expect(svg('logo/mark-on-light')).toContain(`stop-color="${mark.gradientEnd}"`);
    expect(svg('logo/mark-on-light')).toContain(`fill="${mark.dotOnLight}"`);
  });

  it('say they are generated', () => {
    for (const name of ['icon/icon', 'icon/icon-rounded', 'logo/mark-on-dark', 'logo/mark-on-light']) {
      expect(svg(name)).toContain('Generated by brand/scripts/generate.swift');
    }
  });
});

describe('web and site icons', () => {
  it('match the sizes the web manifest names, with separate maskable icons', () => {
    const manifest = JSON.parse(fs.readFileSync('apps/web/public/manifest.webmanifest', 'utf8'));
    for (const i of manifest.icons) {
      const [w, h] = i.sizes.split('x').map(Number);
      const { width, height } = png(`apps/web/public/${i.src}`);
      expect({ src: i.src, width, height }).toEqual({ src: i.src, width: w, height: h });
      // A maskable icon is cropped to a circle; the full-size mark would lose its corners.
      expect(i.purpose === 'maskable').toBe(i.src.startsWith('icon-maskable-'));
    }
  });

  it('the touch icons are 180 px and opaque (iOS rounds them)', () => {
    for (const app of ['site', 'web']) {
      expect(png(`apps/${app}/public/apple-touch-icon.png`)).toEqual({ width: 180, height: 180, colourType: 2 });
    }
  });

  it('the favicon.ico holds 16, 32 and 48 px PNGs', () => {
    const ico = fs.readFileSync('apps/site/public/favicon.ico');
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 3]);
    expect([0, 1, 2].map((i) => ico[6 + 16 * i])).toEqual([16, 32, 48]);
  });

  it('the page logos are the generated tile', () => {
    for (const f of ['apps/site/public/favicon.svg', 'apps/web/public/logo.svg']) {
      expect(fs.readFileSync(f, 'utf8')).toContain('Generated by brand/scripts/generate.swift');
    }
  });
});

describe('the brand kit', () => {
  const logos = fs.readdirSync('brand/logo').filter((f) => f.endsWith('.svg'));

  it('has the mark, the wordmark and the lockup in every colourway', () => {
    for (const art of ['mark', 'wordmark', 'lockup']) {
      for (const c of ['on-dark', 'on-light', 'mono-white', 'mono-black']) expect(logos).toContain(`${art}-${c}.svg`);
    }
    for (const art of ['lockup-endorsed', 'lockup-stacked', 'lockup-tile']) {
      for (const c of ['on-dark', 'on-light']) expect(logos).toContain(`${art}-${c}.svg`);
    }
  });

  it('draws text as outlines, so no logo needs Geist installed', () => {
    for (const f of logos) {
      const s = fs.readFileSync(`brand/logo/${f}`, 'utf8');
      expect(s, f).not.toMatch(/<text|font-family/);
      expect(s, f).toContain('Generated by brand/scripts/generate.swift');
    }
  });

  it('has a PNG of every logo', () => {
    const pngs = fs.readdirSync('brand/logo/png');
    for (const f of logos) expect(pngs).toContain(f.replace('.svg', '.png'));
  });

  it('ships Geist with its licence', () => {
    for (const w of ['Regular', 'Medium', 'SemiBold', 'Bold']) expect(fs.existsSync(`brand/fonts/Geist-${w}.otf`)).toBe(true);
    expect(fs.readFileSync('brand/fonts/OFL.txt', 'utf8')).toContain('SIL OPEN FONT LICENSE');
  });

  it('sizes each social image for its network', () => {
    for (const [file, width, height] of [
      ['og-1200x630', 1200, 630], ['github-social-1280x640', 1280, 640], ['x-header-1500x500', 1500, 500], ['linkedin-banner-1128x191', 1128, 191],
      ['linkedin-cover-1584x396', 1584, 396], ['youtube-banner-2560x1440', 2560, 1440], ['profile-800', 800, 800],
    ] as const) {
      expect({ file, ...png(`brand/social/${file}.png`) }).toMatchObject({ file, width, height });
    }
  });

  it("the site's link preview is the kit's", () => {
    expect(fs.readFileSync('apps/site/public/og.png').equals(fs.readFileSync('brand/social/og-1200x630.png'))).toBe(true);
  });

  it('the animated mark stays still under reduced motion', () => {
    expect(fs.readFileSync('brand/motion/mark-animated.svg', 'utf8')).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*animation: none/);
  });
});

describe('brand contrast (brand/README.md)', () => {
  const appBackground = tokens.color.dark.bg; // Theme.background

  it('lavender is AA text on the dark app background', () => {
    expect(contrast(mark.lavender, appBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it('the white mark has AA contrast on both ends of the tile gradient', () => {
    for (const end of [mark.gradientStart, mark.gradientEnd]) expect(contrast(mark.glyph, end)).toBeGreaterThanOrEqual(4.5);
  });

  it('white is AA on the brand purple, for a filled control', () => {
    expect(contrast('#FFFFFF', mark.gradientStart)).toBeGreaterThanOrEqual(4.5);
  });

  it('the brand purple is not text on dark (the README says so)', () => {
    expect(contrast(mark.gradientStart, appBackground)).toBeLessThan(4.5);
  });
});
