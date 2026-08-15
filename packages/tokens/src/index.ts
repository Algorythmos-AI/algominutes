// @algominutes/tokens — externalised user-facing strings (A6.7) and design tokens.
//
// Strings are authored ONCE here (English v1.0; French next, translation is P1)
// and consumed by all three clients. The web imports `t()` / `strings` directly.
// iOS and Android consume generated platform files (Localizable.strings /
// strings.xml) produced from strings/en.json — see README ("client generation").
//
// The RULE: no new user-facing string is hardcoded in a client. Add it here,
// reference it by key. Retrofitting i18n across three clients later is miserable,
// which is why this exists now (A6.7 is P0).

import en from '../strings/en.json' with { type: 'json' };

export type Strings = typeof en;
export type Locale = 'en';

/** The full string catalog for a locale (only `en` today). */
export const catalog: Record<Locale, Strings> = { en };

/** Typed access to the default-locale strings, e.g. `strings.recorder.stop`. */
export const strings: Strings = en;

/**
 * Look up a string by dot-path with `{param}` interpolation, e.g.
 *   t('recorder.capWarning', { left: 'About 3 minutes', capHours: 2 })
 * Falls back to the key itself if missing, so a typo is visible, never a crash.
 */
export function t(
  path: string,
  params?: Record<string, string | number>,
  locale: Locale = 'en',
): string {
  const found = path
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), catalog[locale]);
  let out = typeof found === 'string' ? found : path;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}
