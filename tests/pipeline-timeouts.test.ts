import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IN_FLIGHT_STALE_MS } from '@algominutes/db';

// Cross-service timing invariant. The kickoff treats a note as stuck (and lets
// it re-queue, which resets it) after IN_FLIGHT_STALE_MS in one status. A LIVE
// job can sit in 'transcribing' for up to MAX_STT_POLLS polls, 60 s apart,
// before the transcoder fails the note itself. If the stale window were
// shorter, a slow but healthy 4 h recording could be reset by a client retry.
describe('pipeline timeouts', () => {
  it('the in-flight stale window outlasts the transcoder STT poll budget', () => {
    const src = readFileSync(resolve(__dirname, '../services/transcoder/src/handler.js'), 'utf-8');
    const polls = Number(/const MAX_STT_POLLS = (\d+);/.exec(src)?.[1]);
    const pollDelaySec = 60; // tasks.enqueue({ kind: STT_POLL, ... }, 60)
    expect(src).toMatch(/kind: STT_POLL[\s\S]{0,200}?\},\s*60,?\s*\)/);
    expect(polls).toBeGreaterThan(0);
    const sttBudgetMs = polls * pollDelaySec * 1000;
    expect(IN_FLIGHT_STALE_MS).toBeGreaterThan(sttBudgetMs + 30 * 60 * 1000); // 30 min headroom
  });
});
