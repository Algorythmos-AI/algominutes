'use strict';

// §4.6 spend circuit breaker — halts the expensive AI pipeline when today's spend
// exceeds a HARD daily cap. GCP budget alerts only NOTIFY; this STOPS. A free tier
// + an AI pipeline + no cap is how a solo-founder product generates a five-figure
// bill overnight (BUILD-PLAN §4.6, non-negotiable P0).
//
// DATA/LOGIC ONLY — no model client, no network at import. Lives in @algominutes/ai
// so every worker can `loadShared('spend-guard.cjs')`.
//
// Cap source (per environment):
//   1. env DAILY_SPEND_CAP_AUD (set at deploy — A11), else
//   2. per-env default below (staging A$20, prod A$200 — INFRASTRUCTURE §4.4).
//
// Spend source: a pluggable reader returning the last 24 hours' cost in AUD.
// The workers install @algominutes/db spend-repo.cjs (minutes debited in
// usage_ledger x a blended cost per minute); the default below returns 0, so a
// process that installs none is uncapped.

const DEFAULT_CAPS_AUD = { production: 200, prod: 200, staging: 20, development: 5, test: 1e9 };

function envName() {
  return process.env.ALGOMINUTES_ENV || process.env.NODE_ENV || 'development';
}

/** The hard daily cap in AUD for the current environment. */
function dailyCapAUD() {
  const fromEnv = Number(process.env.DAILY_SPEND_CAP_AUD);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const key = envName();
  return DEFAULT_CAPS_AUD[key] != null ? DEFAULT_CAPS_AUD[key] : DEFAULT_CAPS_AUD.development;
}

class SpendCapExceededError extends Error {
  constructor(spent, cap) {
    super(`daily_spend_cap_exceeded: A$${spent.toFixed(2)} >= A$${cap.toFixed(2)}`);
    this.name = 'SpendCapExceededError';
    this.code = 'SPEND_CAP_EXCEEDED';
    this.retryable = false; // do not let Cloud Tasks retry-storm while capped
    this.spent = spent;
    this.cap = cap;
  }
}

// async () => number: the last 24 hours' spend in AUD. The workers install the
// ledger reader at startup (setDailySpendReader).
let _spendReader = async () => 0;

/** Install the spend reader (the workers' index.js). */
function setDailySpendReader(fn) {
  if (typeof fn !== 'function') throw new TypeError('spend reader must be a function');
  _spendReader = fn;
}

/**
 * Trip the breaker if today's spend has reached the cap. Call this at the top of
 * every expensive AI worker BEFORE the paid work (STT, Gemini, embeddings).
 *
 * - Under cap        -> resolves { ok: true, spent, cap }.
 * - At/over cap      -> throws SpendCapExceededError (code SPEND_CAP_EXCEEDED).
 * - Reader errored   -> fails OPEN (allows the work) + logs `spend_guard_reader_failed`,
 *                       so a broken meter cannot take the whole product down. The
 *                       budget alerts + monitoring are the backstop for a sustained
 *                       meter outage. (Decision recorded in docs/DECISIONS.md.)
 */
async function assertUnderDailyCap({ log } = {}) {
  const cap = dailyCapAUD();
  let spent;
  try {
    spent = await _spendReader();
  } catch (err) {
    if (log) log.error({ err }, 'spend_guard_reader_failed');
    return { ok: true, spent: null, cap, degraded: true };
  }
  if (typeof spent !== 'number' || !Number.isFinite(spent)) {
    if (log) log.error({ spent }, 'spend_guard_reader_bad_value');
    return { ok: true, spent: null, cap, degraded: true };
  }
  if (spent >= cap) {
    if (log) log.error({ spent, cap, env: envName() }, 'spend_cap_tripped');
    throw new SpendCapExceededError(spent, cap);
  }
  if (log && spent >= cap * 0.8) log.warn({ spent, cap }, 'spend_cap_approaching');
  return { ok: true, spent, cap };
}

/**
 * A worker's gate before paid work. At the cap, the note it was about to pay for
 * is failed (Postgres first, through `markFailed`), refunded and its author told
 * (`onCapped`, the worker's terminal hooks), and the task is acknowledged. It
 * used to be acknowledged alone, which left the note in progress until the
 * stuck-note sweep. Returns the response to send, or null to carry on.
 *
 * `markFailed` resolves `{ failed }`: whether it moved the note to 'error'. Only
 * that transition runs the hooks and stops the task. A note it didn't fail (work
 * already started on it, it moved on, it's in another workspace, or a replay
 * after this gate already failed it) carries on to the worker, which resumes or
 * acknowledges it as it would anyway, and nobody is refunded or told twice.
 *
 * `markFailed` throws if Postgres misses the write: the answer is then 500, so
 * the task retries and checks again. On the queue's last attempt that drops the
 * task with the note still queued in both stores, for the stuck-note sweep to
 * fail and refund; guessing at the mirror without Postgres would be worse.
 */
async function haltAtSpendCap({ log, noteId, workspaceId, markFailed, onCapped }) {
  try {
    await assertUnderDailyCap({ log });
    return null;
  } catch (err) {
    if (!err || err.code !== 'SPEND_CAP_EXCEEDED') {
      log.error({ err, noteId, workspaceId }, 'spend_guard_failed');
      return { status: 500, body: { error: 'spend_guard_failed' } };
    }
    log.error({ err, noteId, workspaceId }, 'spend_cap_tripped_pipeline_halted');
    if (!noteId || !workspaceId) return { status: 200, body: { ok: false, reason: 'spend_cap' } };
    let failed;
    try {
      ({ failed } = await markFailed());
    } catch (markErr) {
      log.error({ err: markErr, noteId, workspaceId }, 'spend_cap_note_write_failed');
      return { status: 500, body: { error: 'note_write_failed' } };
    }
    if (!failed) return null;
    try {
      await onCapped(err);
    } catch (hookErr) {
      log.error({ err: hookErr, noteId, workspaceId }, 'spend_cap_hooks_failed');
    }
    return { status: 200, body: { ok: false, reason: 'spend_cap' } };
  }
}

/** What the author sees on a note stopped by the cap. */
const SPEND_CAP_MESSAGE = "We've reached today's processing limit. Please try again tomorrow.";

module.exports = {
  assertUnderDailyCap,
  haltAtSpendCap,
  SPEND_CAP_MESSAGE,
  setDailySpendReader,
  dailyCapAUD,
  SpendCapExceededError,
};
