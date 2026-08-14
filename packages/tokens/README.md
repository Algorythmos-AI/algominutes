# @algominutes/tokens

Design tokens + i18n strings, defined **once** and consumed by all three clients:
the web Tailwind `@theme`, SwiftUI `Theme.swift`, and the Compose theme.

- `tokens.json` — palette, type scale, radii, shadows. **TODO(brand A6.5)** — currently a neutral
  placeholder; the client "INTEGRANT" tokens were deliberately not carried over.
- `strings/en.json` — externalised user-facing strings. **TODO(i18n A6.7)** — populated as A6.4/A6.6
  audit each surface. English in v1.0, French next.
