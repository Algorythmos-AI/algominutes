# Gemini capacity request: gemini-3.5-flash in australia-southeast1

**Draft for the owner, 2026-10-29.** The owner's half of S2 and S17 (RELEASE.md R12.3 and "Status,
2026-10-27"). Phase A's gate: "S17 mitigated or accepted in writing with capacity on order". Nothing has been
submitted to Google.

Labels: **[code]** read from `origin/integration` at aa7a8e38. **[measured]** Cloud Logging or the Quotas API,
2026-10-27/28, aggregates only. **[estimated]** an assumption, or a figure worked out from one.

## Owner decisions

- **Order Provisioned Throughput for production, sized for 1,000 users a day** (§3). Default: yes, shortest
  term (RELEASE.md status decision 1, R12.6 decision 6).
- **The location fallback (#506) stays off.** Turn it on only with `processing.json`, the Privacy Policy and a
  DECISIONS entry, Melbourne first if it serves the model (status decision 1). Default: off.
- **If Google refuses:** keep invite waves small and record the single-model risk in DECISIONS, with the
  retry window as the mitigation (R12.6 decision 6). Default: that.

## 1. Evidence

**What the app calls [code].** gemini-3.5-flash in australia-southeast1 (`packages/ai/src/models.cjs`,
`REGION`, `LADDER`, `CHAT_MODEL`). gemini-2.5-flash retired 2026-10-20, so the ladder runs on one rung
(`SINGLE_RUNG_DECISION`, DECISIONS 2026-09-28). Chat uses 3.5-flash. Embeddings use text-embedding-004 via
`:predict`, a separate quota.

**Calls per recording [code].** One generateContent either way, plus retries: the transcoder's fast path sends
short audio inline (transcript and summary in one call); longer audio and bot recordings go to Speech-to-Text,
then one summarizer call. Chat: one streamGenerateContent per question, plus one embedding.

**Tokens.** About 1,920 tokens per audio minute plus about 1,000 of prompt and schema [estimated]. On staging
over 14 days [measured]: transcoder 267 calls, mean 785 prompt / 252 output (short test clips); summarizer 30
calls, mean 10,639 prompt (max 43,110) / 878 output.

**Staging, 2026-10-24 → 10-28 [measured].** 521 attempts, 285 successes; 29% of attempts refused with 429, all
on gemini-3.5-flash; about 15% of calls ended `gemini_model_exhausted`. The busiest minute had 9 attempts.

**Staging chat, 2026-10-28 22:35 UTC [measured].** The scheduled web journey (`web-e2e.yml`, against staging)
failed on chat with a 429: `chat_model_busy_retrying`, then `chat_stream_failed`. Chat shares the same
capacity, so S2/S17 reaches Ask AI too, not only notes.

**Production, 2026-10-27 [measured].** Its only Gemini traffic so far: `gemini_rate_limited` 22,
`gemini_transient` 22, `gemini_model_exhausted` 8, `gemini_attempt_timeout` 2, **`gemini_ok` 1**. One 23-second
recording took 19 minutes and four task attempts (S17).

## 2. Current quotas [measured, read-only; same in both projects]

Sydney has no per-project request or token quota row for gemini-3.5-flash (input and output token limits read
-1; audio input 11,000,000 default; embedding predict 30,000 RPM). So the 429s come from Google's shared
capacity, and there is no per-project quota to raise. That reading is inferred, not confirmed by Google.

## 3. The request

**Load [estimated].** 30 recorded minutes a day per user as three 10-minute fast-path recordings, 3 chat
questions a day, peak minute = 0.5% of the day; "with retries" uses the measured 1.8 attempts per success.

| Users/day | Peak RPM | with retries | Peak input TPM | Peak output TPM | Peak QPS |
|---|---|---|---|---|---|
| 100 | 3 | 6 | 36,000 | 4,500 | 0.05 |
| 1,000 | 30 | 54 | 360,000 | 45,000 | 0.5 |
| 5,000 | 150 | 270 | 1,800,000 | 225,000 | 2.5 |

**Ask for:**
1. **Provisioned Throughput** for gemini-3.5-flash in australia-southeast1 on `algominutes-production`, sized
   for 1,000 users a day: 0.5 QPS, about 12,000 input tokens (about 80% audio) and 1,500 output per request,
   shortest term. Let the console estimator set the GSU count. Traffic above it still uses shared capacity.
2. In the same request: whether a per-project quota or priority pay-as-you-go exists for this model in Sydney.
3. Embeddings need nothing.

**Justification text to paste:**

> AlgoMinutes transcribes and summarises recorded meetings for Australian users. For data residency, every
> Gemini call must run in australia-southeast1. Since gemini-2.5-flash retired on 2026-10-20, gemini-3.5-flash
> is the only Gemini Flash model served in Sydney, so we have no in-region fallback.
>
> At near-zero traffic we receive 429 RESOURCE_EXHAUSTED on gemini-3.5-flash in australia-southeast1. On our
> staging project from 2026-10-24 to 2026-10-28, 29% of generateContent attempts were refused with 429, and the
> busiest minute had only 9 requests. On production on 2026-10-27, only 1 of 55 logged Gemini outcomes was a success, and one 23-second
> recording took 19 minutes. The project has no per-project quota row for this model in this region, so we
> understand the refusals come from shared capacity.
>
> We are launching in November 2026. Our planned peak is 30 requests per minute (0.5 QPS), about 360,000 input
> and 45,000 output tokens per minute, mostly audio (about 1,920 tokens per audio minute). Requests use
> structured JSON output with a response schema and low thinking. We expect growth to about 150 requests per
> minute.
>
> We request Provisioned Throughput for gemini-3.5-flash in australia-southeast1, sized for 0.5 QPS at about
> 12,000 input and 1,500 output tokens per request, on the shortest available term. If a per-project quota
> allocation or priority pay-as-you-go tier for this model in this region is available instead, we would
> accept it.

("1 of 55": the one `gemini_ok` among the 55 outcome log events counted above; they are events, not distinct
requests. Recount before sending if production has had more traffic since.)

## 4. Owner click path (`algominutes-production`, 43914754953)

1. console.cloud.google.com › project `algominutes-production`.
2. Vertex AI › Provisioned Throughput › New order (labels may have changed).
3. Model gemini-3.5-flash, region australia-southeast1, shortest term.
4. Estimator: QPS 0.5, input 12,000 (about 80% audio), output 1,500. Accept its GSU count; paste §3's text.
5. Review the monthly cost; submit. Google reviews the order.

Optional read-only check first: IAM & Admin › Quotas & System Limits, filter Vertex AI API, australia-southeast1,
"generate_content". If a gemini-3.5-flash row exists, request 60 RPM and 400k input TPM there with the same
text. If the order page refuses Sydney: Support › Create case › Vertex AI › quota/capacity, with §3's text.

## 5. If refused

What the code already does [code]: on a 429, 5 attempts on the rung at 2/4/8/16 s plus jitter (#505), inside
the ladder's 240 s budget; per-attempt caps on the transcoder; the task is retried by Cloud Tasks (summarize up
to 10 times over about an hour); chat retries; `VERTEX_FALLBACK_LOCATIONS` empty by default (#506), and any
location must first be in `processing.json` (`tests/vertex-locations-policy.test.ts`); alerts on
`gemini_rate_limited`, `gemini_model_exhausted`, `gemini_attempt_timeout`.

Options: small invite waves until capacity is on order; Melbourne (australia-southeast2) if a probe shows
3.5-flash served there (still Australia; needs the privacy-table entry); a non-Australian region only with a
residency change in DECISIONS and the Privacy Policy.

DECISIONS should record: the request date and Google's answer; that the 09-28 condition "revisit if
gemini_transient fires in production" was met on 10-27; the sizing and the resize trigger (for example 429s
above 5% of a day's attempts, or more than 800 users a day); the fallback if refused; the monthly cost as an
operating cost.

## Not verified

That Google treats this as shared quota; GSU rates, minimum order and term; whether Provisioned Throughput or
priority pay-as-you-go is offered for 3.5-flash in Sydney; whether production already holds an order; whether
3.5-flash is served in australia-southeast2; the real recording-length mix and peak shape; current console
labels; the exact retry counts for summarize and chat (stated from R12.6 and the 10-27 plan, not re-read
from the queue configs).
