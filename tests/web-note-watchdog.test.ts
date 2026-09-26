import { describe, it, expect } from 'vitest';
import { watchdogPass, isSlow } from '../apps/web/src/lib/noteWatchdog';

// The web watchdog fails only a note it owns (`processing`, before the
// kickoff). A note the server owns is reported slow, never written: the
// server's sweep fails a stuck run itself, Postgres first.
const now = Date.parse('2026-09-25T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const note = (id: string, status: string, ageMs: number, extra: Record<string, unknown> = {}) =>
  ({ id, status, updatedAt: ago(ageMs), ...extra }) as never;

describe('the web note watchdog', () => {
  it("fails only its own stale 'processing' note; a stale server-owned note is slow", () => {
    const pass = watchdogPass([
      note('upload-died', 'processing', 120_000),
      note('queued-long', 'queued', 120_000),
      note('summarizing-long', 'summarizing', 300_000),
      note('fresh', 'transcribing', 60_000),
      note('done', 'ready', 10 * 3_600_000),
      note('failed', 'error', 10 * 3_600_000),
    ], now);
    expect(pass).toEqual({ toFail: ['upload-died'], slow: ['queued-long', 'summarizing-long'] });
  });

  it('an upload heartbeat (lastProgressAt) keeps a processing note alive', () => {
    expect(isSlow(note('n', 'processing', 600_000, { lastProgressAt: ago(30_000) }), now)).toBe(false);
  });

  it("a long recording's transcription gets three times its length", () => {
    // 60 minutes of audio, 20 minutes in: not slow; 200 minutes in: slow.
    expect(isSlow(note('n', 'transcribing', 20 * 60_000, { duration: 3600 }), now)).toBe(false);
    expect(isSlow(note('n', 'transcribing', 200 * 60_000, { duration: 3600 }), now)).toBe(true);
  });
});
