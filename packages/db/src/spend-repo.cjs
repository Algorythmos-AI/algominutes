'use strict';

/**
 * The spend reader behind the §4.6 daily cap (@algominutes/ai/spend-guard.cjs):
 * an estimate of the last 24 hours' pipeline cost, in AUD.
 *
 * It sums the audio minutes the transcoder actually sent to be paid for
 * (usage_events, written by pipeline-repo recordPaidWork as each speech job or
 * fast-path Gemini call starts, with the duration it measured itself), times a
 * blended cost per minute. Not the usage_ledger debits: those come from the
 * duration the client reports (an import sends none, so it was debited 0), and
 * a note retried after a refund reuses its debit key, so its rerun was never
 * counted. A rolling 24 hours rather than a calendar day, so there is no
 * midnight cliff and no time zone to choose.
 *
 * The rate is COGS_AUD_PER_MINUTE, or a deliberately high default until the
 * real blended cost is measured (BLOCKERS A11); see DECISIONS "Spend cap".
 */

const DEFAULT_COGS_AUD_PER_MINUTE = 0.03;

function cogsPerMinuteAUD(env = process.env) {
  const fromEnv = Number(env.COGS_AUD_PER_MINUTE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_COGS_AUD_PER_MINUTE;
}

/** Minutes of audio sent to paid work in the last 24 hours, across every account (a cost figure, not user data). */
async function paidMinutesLast24h(pool) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(audio_seconds), 0)::float8 / 60 AS minutes
       FROM usage_events
      WHERE created_at > NOW() - INTERVAL '24 hours' AND audio_seconds IS NOT NULL`,
  );
  return Number(rows[0].minutes);
}

/**
 * async () => AUD, for spendGuard.setDailySpendReader. `pool` is a function
 * returning the service's pg pool, so installing the reader opens nothing.
 * Cached per process for `cacheMs`: the gate runs on every task.
 */
function createPaidWorkSpendReader({ pool, ratePerMinute = cogsPerMinuteAUD(), cacheMs = 60_000, now = Date.now }) {
  let cached = null;
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const value = (await paidMinutesLast24h(pool())) * ratePerMinute;
    cached = { at: now(), value };
    return value;
  };
}

module.exports = { createPaidWorkSpendReader, paidMinutesLast24h, cogsPerMinuteAUD, DEFAULT_COGS_AUD_PER_MINUTE };
