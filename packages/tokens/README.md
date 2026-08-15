# @algominutes/tokens

Design tokens + **externalised user-facing strings (A6.7)**, defined **once** and consumed by all three
clients: the web, SwiftUI, and Compose.

## Strings (i18n)

- `strings/en.json` — the string catalog, namespaced (`app`, `common`, `nav`, `auth`, `recorder`,
  `states`, `note`, `errors`, `onboarding`). English is v1.0; **French is next** (add `strings/fr.json`).
  Translation is P1; the externalisation (this catalog + accessor) is P0 and lands now so it is never a
  retrofit.
- `src/index.ts` — the typed accessor:
  - `strings.recorder.stop` — typed dot access.
  - `t('recorder.capWarning', { left: 'About 3 minutes', capHours: 2 })` — dot-path lookup with
    `{param}` interpolation; falls back to the key if missing (a typo is visible, never a crash).

**The rule:** no new user-facing string is hardcoded in a client. Add it here, reference it by key.

### Web
```ts
import { t, strings } from '@algominutes/tokens';
<button>{t('common.save')}</button>
```

### iOS / Android — client generation
Swift and Kotlin can't import the TS module, so platform string files are **generated** from
`strings/en.json` (same single-source principle as `packages/contracts` models):
- iOS: generate `Localizable.strings` (per locale) → `NSLocalizedString(key, comment:)`.
- Android: generate `res/values/strings.xml` (and `values-fr/…`).
- **TODO(A6.7):** add the `strings:gen` codegen script (json → .strings / .xml) and wire it like
  `contracts` `npm run models`. Until then the generated files are produced by hand from this catalog.

### Migration status
The catalog holds the common/shared strings today. **TODO(A6.7 sweep):** the exhaustive per-file
migration of every remaining hardcoded string in `apps/web` and `apps/ios` is ongoing — move each string
into the relevant namespace here and reference it by key. Template labels/blurbs are intentionally **not**
duplicated here: they live with the template set in `@algominutes/contracts` (`SUMMARY_TEMPLATES`), the
single source for that contract.

## Design tokens

- `tokens.json` — palette, type scale, radii, shadows. **TODO(brand A6.5)** — neutral placeholder; the
  client "INTEGRANT" tokens were not carried over. The real values land in A6.5 and apply to web
  (Tailwind `@theme`), SwiftUI `Theme.swift`, and the Compose theme.
