# AlgoMinutes

**AI meeting recorder** — record a meeting, transcribe it with speaker labels, and get structured
minutes with decisions and action items. Native **iOS** (SwiftUI) and **Android** (Kotlin/Compose)
capture; a **React** web app reads, manages and pays. The rule: **mobile records, web reads.**

Published by **Algorythmos Pty Ltd** (ACN 701 006 626 · ABN 22 701 006 626, Sydney NSW).
Proprietary — see [`LICENSE`](./LICENSE).

## Monorepo layout

```
apps/
  ios/         Native SwiftUI (capture + review)
  android/     Native Kotlin + Jetpack Compose (capture + review)
  web/         React 19 + Vite + Tailwind (review, manage, pay — no capture)
services/
  api/         Consolidated HTTP surface for all clients (auth, notes, search, chat, export)
  transcoder/  Audio → chunks → STT v2
  summarizer/  Transcript → structured summary (Vertex)
  embedder/    Chunks → pgvector
  extractor/   Document text extraction: PDF, DOCX, OCR, YouTube
  billing/     Receipt validation, Stripe + store webhooks, entitlements
  notifier/    FCM fan-out, email
packages/
  contracts/   zod schemas → OpenAPI; Swift + Kotlin models generated from here
  db/          schema, migrations, repo layer (single Postgres, accessed only via the repo)
  ai/          gemini-call, prompt templates, redaction
  tokens/      design tokens + i18n strings
infra/         IaC, deploy config
docs/          BUILD-PLAN, EXTRACTION-AUDIT, DECISIONS, BLOCKERS, runbooks
```

## Engineering invariants

See [`CLAUDE.md`](./CLAUDE.md). In short: Postgres is the source of truth and all note mutations go
through the repo layer; async between services only (no synchronous service-to-service calls in a user
request path); every async handler is idempotent; PII is scrubbed before any model or embedder call;
Vertex AI clients run only inside Cloud Run; contracts live in `packages/contracts` and are versioned.

## Status

Foundation phase. See [`docs/BUILD-PLAN.md`](./docs/BUILD-PLAN.md) for the roadmap,
[`docs/EXTRACTION-AUDIT.md`](./docs/EXTRACTION-AUDIT.md) for the source audit, and
[`docs/DECISIONS.md`](./docs/DECISIONS.md) for the decision log.
