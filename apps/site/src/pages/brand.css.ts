// /brand.css: the colour custom properties, generated from packages/tokens
// (the one source for iOS, Android and the web), so the site can't drift.
import type { APIRoute } from 'astro';
import tokens from '@algominutes/tokens/tokens.json';

const m = tokens.brand.mark;
const dark = tokens.color.dark;
const light = tokens.color.light;

export function brandCss(): string {
  const scheme = (s: typeof dark, extra: Record<string, string>) =>
    Object.entries({
      bg: s.bg, 'bg-2': s.bg2, card: s.card, border: s.border, heading: s.heading, body: s.body, muted: s.muted,
      ...extra,
    })
      .map(([k, v]) => `  --${k}: ${v};`)
      .join('\n');
  return [
    ':root {',
    `  --mark-start: ${m.gradientStart};`,
    `  --mark-end: ${m.gradientEnd};`,
    `  --on-mark: ${m.glyph};`,
    `  --font-body: ${tokens.typography.fontFamily.body};`,
    `  --font-mono: ${tokens.typography.fontFamily.mono};`,
    `  --radius-md: ${tokens.radius.md};`,
    `  --radius-lg: ${tokens.radius.lg};`,
    `  --focus-ring: ${tokens.a11y.focusRing};`,
    '  color-scheme: dark light;',
    scheme(dark, { bg: m.navy, card: m.ink, border: `color-mix(in srgb, ${m.lavender} 20%, ${m.navy})`, link: m.lavender, accent: m.dot }),
    '}',
    '@media (prefers-color-scheme: light) {',
    '  :root {',
    scheme(light, { heading: m.ink, link: m.gradientStart, accent: m.dotOnLight }).replace(/^/gm, '  '),
    '  }',
    '}',
    '',
  ].join('\n');
}

export const GET: APIRoute = () => new Response(brandCss(), { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
