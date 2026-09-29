import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// SLO 4 (docs/SLO.md), timed by the summarizer from the kickoff that queued the run (RELEASE.md PR 15b).
const require = createRequire(import.meta.url);
const { timeToSummary, slo4ObjectiveSec } = require('../services/summarizer/src/slo.js');

const queuedAt = '2026-09-29T10:00:00.000Z';
const at = (sec: number) => Date.parse(queuedAt) + sec * 1000;

describe('time to summary', () => {
  it('is half the recording plus 5 minutes: a 60-minute recording has 35 minutes', () => {
    expect(slo4ObjectiveSec(3600)).toBe(2100);
    expect(timeToSummary({ queuedAt, recordingSec: 3600, now: at(2100) })).toEqual({ fields: { timeToSummarySec: 2100, recordingSec: 3600, objectiveSec: 2100 }, missed: false });
    expect(timeToSummary({ queuedAt, recordingSec: 3600, now: at(2101) }).missed).toBe(true);
  });

  it('a 2-minute recording has 6 minutes', () => {
    expect(timeToSummary({ queuedAt, recordingSec: '120', now: at(361) })).toMatchObject({ fields: { objectiveSec: 360 }, missed: true });
  });

  it("isn't judged for a regeneration, a run from before queued_at, or a length SLO 4 doesn't cover", () => {
    expect(timeToSummary({ queuedAt, recordingSec: 60, regeneration: true, now: at(9999) })).toEqual({ fields: {}, missed: false });
    expect(timeToSummary({ queuedAt: null, recordingSec: 60, now: at(9999) })).toEqual({ fields: {}, missed: false });
    // Longer than 4 hours, or unknown: timed, never missed.
    expect(timeToSummary({ queuedAt, recordingSec: 5 * 3600, now: at(99999) })).toEqual({ fields: { timeToSummarySec: 99999 }, missed: false });
    expect(timeToSummary({ queuedAt, recordingSec: null, now: at(99999) })).toEqual({ fields: { timeToSummarySec: 99999 }, missed: false });
  });
});
