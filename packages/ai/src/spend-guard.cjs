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
// Spend source: a pluggable reader returning today's accumulated cost in AUD.
// Until the usage_ledger + per-minute COGS wiring lands (A9), the default reader
// returns 0 — the breaker is present and wired but inert. Wire it in A9 via
// setDailySpendReader(). See TODO(A9) below.

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

// TODO(A9): replace with a reader over usage_ledger / the billing export —
// async () => number (today's spend in AUD, project-scoped, cached ~1 min).
let _spendReader = async () => 0;

/** Inject the real daily-spend reader (A9). */
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

module.exports = {
  assertUnderDailyCap,
  setDailySpendReader,
  dailyCapAUD,
  SpendCapExceededError,
};
