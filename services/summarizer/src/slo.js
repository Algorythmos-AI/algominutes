'use strict';
// SLO 4 (docs/SLO.md): a recording's time to summary, timed by the summarizer (RELEASE.md PR 15b).

/** SLO 4's objective (docs/SLO.md): half the recording's length plus 5 minutes, for recordings up to 4 hours. */
const SLO4_MAX_RECORDING_SEC = 4 * 3600;
const slo4ObjectiveSec = (recordingSec) => Math.round(recordingSec / 2 + 300);

/**
 * A pipeline run's time to summary, from the kickoff that queued it (notes.queued_at, migration 026), for
 * summarizer_complete, and whether it missed SLO 4. A regeneration isn't timed (its clock is the regenerate
 * request's), nor a run queued before queued_at existed, nor a recording SLO 4 doesn't cover.
 */
function timeToSummary({ queuedAt, recordingSec, regeneration, now = Date.now() }) {
  if (regeneration || !queuedAt) return { fields: {}, missed: false };
  const timeToSummarySec = Math.max(0, Math.round((now - new Date(queuedAt).getTime()) / 1000));
  const recording = recordingSec == null ? null : Number(recordingSec);
  if (!Number.isFinite(recording) || recording <= 0 || recording > SLO4_MAX_RECORDING_SEC) {
    return { fields: { timeToSummarySec }, missed: false };
  }
  const objectiveSec = slo4ObjectiveSec(recording);
  return { fields: { timeToSummarySec, recordingSec: Math.round(recording), objectiveSec }, missed: timeToSummarySec > objectiveSec };
}

module.exports = { timeToSummary, slo4ObjectiveSec, SLO4_MAX_RECORDING_SEC };
