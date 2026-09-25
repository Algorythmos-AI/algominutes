'use strict';

/**
 * The spend reader behind the §4.6 daily cap (@algominutes/ai/spend-guard.cjs):
 * an estimate of the last 24 hours' pipeline cost, in AUD.
 *
 * Every kickoff debits its recording's minutes in usage_ledger before any paid
 * work, so the minutes debited in a window times a blended cost per minute
 * (speech + Gemini) is the best signal there is: usage_events, meant for
 * per-call cost, is never written, and the billing export lags by hours.
 * Refunds don't lower it (a failed run was usually paid for anyway), except the
 * cap's own ('refund:spend_cap'): that note was stopped before any paid work, so
 * its debit nets out, and a stream of capped uploads can't hold the cap shut. A rolling
 * 24 hours rather than a calendar day, so there is no midnight cliff and no
 * time zone to choose.
 *
 * The rate is COGS_AUD_PER_MINUTE, or a deliberately high default until the
 * real blended cost is measured (BLOCKERS A11); see DECISIONS "Spend cap".
 */

const DEFAULT_COGS_AUD_PER_MINUTE = 0.03;

function cogsPerMinuteAUD(env = process.env) {
  const fromEnv = Number(env.COGS_AUD_PER_MINUTE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_COGS_AUD_PER_MINUTE;
}

/** Minutes debited in the last 24 hours, across every account (a cost figure, not user data). */
async function debitedMinutesLast24h(pool) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(minutes), 0)::float8 AS minutes
       FROM usage_ledger
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND (entry_type = 'debit' OR reason = 'refund:spend_cap')`,
  );
  // A cap refund can outlive its debit in the window for a while.
  return Math.max(0, Number(rows[0].minutes));
}

/**
 * async () => AUD, for spendGuard.setDailySpendReader. `pool` is a function
 * returning the service's pg pool, so installing the reader opens nothing.
 * Cached per process for `cacheMs`: the gate runs on every task.
 */
function createLedgerSpendReader({ pool, ratePerMinute = cogsPerMinuteAUD(), cacheMs = 60_000, now = Date.now }) {
  let cached = null;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const value = (await debitedMinutesLast24h(pool())) * ratePerMinute;
    cached = { at: now(), value };
    return value;
  };
}

module.exports = { createLedgerSpendReader, debitedMinutesLast24h, cogsPerMinuteAUD, DEFAULT_COGS_AUD_PER_MINUTE };
