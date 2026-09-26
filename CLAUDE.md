# CLAUDE.md

> Repo-root rules for any Claude Code session in `algominutes`. Read this **first**, every session,
> before touching code. Product roadmap is `docs/BUILD-PLAN.md`; decisions are `docs/DECISIONS.md`.

## 1. Hard invariants — must not be violated

Non-negotiable. Every one is grep-checkable in CI (`scripts/check-*.sh`, `.github/workflows/invariants.yml`)
or directly verifiable.

### Data plane

- **Postgres is the source of truth. Firestore is a denormalized cache.** One Postgres, owned by the
  schema, accessed **only** through the repo layer in `@algominutes/db` (`packages/db`). All note
  mutations go through the repo. **Never** call `noteRef.update(...)` or
  `db.collection('notes').doc(...).set(...)` directly from api, service, or function code. No service
  writes a table it does not own — extend the repo layer, never bypass it.
- **Cloud Run services use Vertex AI clients only.** `aiplatform.googleapis.com` works from the VPC
  connector + private-IP setup; `generativelanguage.googleapis.com` does **not**. Importing
  `@google/generative-ai` from `services/*` is a bug — use `@google-cloud/aiplatform` / the Vertex SDK.
  Do not relearn this.
- **The Gemini retry/ladder lives in `@algominutes/ai/gemini-call.cjs`.** Summarizer and the transcoder
  fast-path both go through it. Before fixing any Gemini-call bug, audit this file first so the fix
  doesn't break the other caller.
- **Structured-output Gemini calls must pass `responseMimeType: "application/json"` + `responseSchema`.**
  Without the schema constraint, long outputs silently truncate. Bumping `maxOutputTokens` alone is
  insufficient.

### Logging & errors

- **Every server log line carries `traceId`, `userId`, `noteId`, and `workspaceId` where they exist.**
  Source `traceId` from `X-Cloud-Trace-Context` or `crypto.randomUUID()`, and **propagate it across every
  async hop** — carry it through queue messages so one recording is followable end to end across services.
  Use the structured logger (`@algominutes/ai/logger.cjs`). Never `console.log/warn/error`.
- **No silent catches.** `.catch(() => {})` and `try { ... } catch (_) {}` are forbidden. Pattern:
  `.catch(err => logger.error({ err, noteId, userId, traceId }, 'event_name'))`. CI gate:
  `scripts/check-no-silent-catch.sh`.

### Security & PII

- **PII pre-scrub runs before transcript text reaches Gemini *or* the embedder.** Use
  `@algominutes/ai/redaction.cjs` → `redactPII(text)`. It emits `<<REDACTED:CARD>>`-style tags so the
  model still understands shape. No exceptions — scrub retrieved chunks before any chat/RAG call too.
- **Never `cors: true`.** Use the explicit allowlist driven by the `ALLOWED_ORIGINS` env, matching the
  single CORS middleware in `services/api`.
- **CSP is enabled in production.** Don't disable it without recording the decision in `docs/DECISIONS.md`.
- **Never commit secrets.** `.gitleaks.toml` ships with an **empty allowlist** (BUILD-PLAN §4.2). Firebase
  per-project configs are regenerated per environment and are **git-ignored**, never committed. A test
  fixture that must hold a realistic-but-fake secret uses a targeted inline `# gitleaks:allow` on that
  line — never a blanket path allowlist. Any real secret in git is an incident: rotate, then purge.

### Multi-tenancy

- **Every Postgres query returning user data is filtered by workspace membership** (`workspace_members`).
  A user in workspace A must never retrieve a chunk from workspace B. Test with two accounts before
  claiming closure.

### Idempotency

- **Replaying a Cloud Task must not produce duplicate rows.** `transcript_lines`, `embeddings`,
  `summaries`, `chat_messages` writes use `ON CONFLICT (...) DO UPDATE` / upserts via the repo layer.
  Every async handler is idempotent — Cloud Tasks replay is normal, not exceptional.

## 2. Service rules (BUILD-PLAN §3.3) — keep the topology clean

- **Async between services only** — Cloud Tasks or Pub/Sub. **No synchronous service-to-service calls in
  a user request path.** If `api` needs a worker result, it reads state from Postgres.
- **Dead-letter queue on every queue**, with an admin view. Silent message loss is the worst failure mode.
- **Contracts live in `@algominutes/contracts` and are versioned.** No service reaches into another's
  internals. A contract change is a three-client change — say so before making it. Client and server
  models are generated from `packages/contracts`, never hand-written three times.
- **Each service: own Dockerfile, own CI job, own deploy, own SLO, independently rollback-able.**
- **Do not add a service without recording its operating cost** in `docs/DECISIONS.md` — every service is
  a deploy, a dashboard, an alert, an on-call surface.
- **API is versioned from day one (`/v1`).** Never break a live version; an unsupported client gets a
  friendly "please update", not a 500.

## 3. Forbidden patterns

```js
// ❌ Direct Firestore mutation outside the repo layer
await noteRef.update({ status: 'ready' });
// ✅ Through @algominutes/db
await notesRepo.markReady(noteId, processResult);

// ❌ Public Gemini client from a Cloud Run service
import { GoogleGenerativeAI } from '@google/generative-ai';
// ✅ Vertex AI client
import { VertexAI } from '@google-cloud/vertexai';

// ❌ Unstructured Gemini call for structured output
generationConfig: { maxOutputTokens: 8192 }
// ✅ Schema-constrained
generationConfig: { responseMimeType: 'application/json', responseSchema, maxOutputTokens: 16384 }

// ❌ Silent catch
audioRef.delete().catch(() => {});
// ✅ Logged catch
audioRef.delete().catch(err => logger.error({ err, noteId, traceId }, 'audio_cleanup_failed'));

// ❌ console
console.error('processing failed', err);
// ✅ structured logger
logger.error({ err, traceId, userId, noteId }, 'process_intelligence_failed');

// ❌ cors: true            // ✅ cors: ALLOWED_ORIGINS
// ❌ model.generateContent(transcript)   // ✅ model.generateContent(redactPII(transcript))
```

## 4. Engineering discipline

1. **Audit shared code before touching leaves.** Grep every caller of a shared helper before swapping it.
2. **Every bug closes with evidence** — a query result, a log line, a wall-clock number. Not "I think it works."
3. **Don't stretch scope mid-session.** New bug found → log it, keep going; when scope threatens a release,
   bring the cut, don't silently extend.
4. **Reason about DB state from the database, not from logs alone.** Open psql when in doubt.
5. **Commit the plan before writing code.** Doc changes and code changes are separate concerns.
6. **Verify with a query or a log line, not a deploy.** A Cloud Run revision number is not evidence.
7. **One PR, one concern.** Conventional commits. Branch model: feature branch → PR into **`integration`**
   (default branch = staging) → promotion PR **`integration` → `main`** (= production). `main` accepts only
   promotion PRs from `integration` (`promotion-guard` check); CI green to merge either.
8. **No suppression filters on monitoring.** Known issues stay visible until fixed.

## 5. Sub-agents (`.claude/agents/`)

Mechanical compliance checks, not general review. Invoke **eagerly** after any non-trivial write — cheap,
fast, catch invariant violations before a PR.

| Sub-agent | When to invoke |
|---|---|
| `dual-write-auditor` | After editing the repo layer (`packages/db`), `services/api`, or any `services/*` that mutates note state |
| `pii-scrub-compliance` | After editing the summarizer, embedder, or any Gemini/Vertex/chat call site |
| `log-fields-auditor` | After adding any `logger.*` call, especially in new endpoints or services |
| `silent-catch-detector` | After adding any `try/catch` block or `.catch()` chain |

If a check you'd want has no sub-agent, draft one in `.claude/agents/` rather than checking inline.

## 6. Files not to touch without recording why

- `packages/db/migrations/*.sql` — **never edit a committed migration; add a new one.** Use
  expand/contract so a rollback never strands the schema (BUILD-PLAN §4.4).
- `.gitleaks.toml` — do not widen the (empty) allowlist; use inline `# gitleaks:allow` instead.
- `packages/contracts/**` — a change here is a three-client change; regenerate models, don't hand-edit
  `generated/`.

## 7. When unsure, verify — don't guess

The bar is honest verification, not velocity. If a fix would touch a shared helper without auditing
callers, or claim closure without a query result, stop and verify. Report anything you could **not**
verify rather than asserting it works.
