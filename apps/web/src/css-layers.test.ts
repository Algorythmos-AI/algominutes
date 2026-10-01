import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// RELEASE.md rev 11, C14 (H14). Tailwind v4 puts its utilities in @layer utilities, and CSS outside any layer
// beats every layered rule. An unlayered `p, span, li { color }` therefore overrode every text-colour utility on
// those elements: the red "● RECORDING" rendered in the body colour. Element defaults belong in @layer base,
// below the utilities.
const css = readFileSync(resolve(__dirname, 'index.css'), 'utf8');

/** The CSS with every @layer block (balanced braces) removed: what's left is unlayered. */
function unlayered(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@layer', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    const open = text.indexOf('{', at);
    const semi = text.indexOf(';', at);
    if (semi >= 0 && semi < open) { i = semi + 1; continue; } // `@layer a, b;` declares order, has no body
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('index.css', () => {
  it('sets no element colours outside @layer base, where Tailwind utilities can override them', () => {
    const rules = [...unlayered(css).matchAll(/(^|})\s*([^{}@]+)\{([^}]*)\}/g)];
    const elementColour = rules.filter(([, , selector, body]) =>
      /(^|[\s,])(p|span|li|h[1-6]|body|a)\s*(,|$)/.test(selector.trim()) && /(^|;|\s)color\s*:/.test(body));
    expect(elementColour.map(([, , selector]) => selector.trim())).toEqual([]);
  });
});
