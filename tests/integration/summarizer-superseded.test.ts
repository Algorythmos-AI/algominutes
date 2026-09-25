import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// The summarizer's last write is notes-repo markSummaryReady, which re-checks
// the note's summary generation at the write. When a regenerate was claimed
// during the Gemini call, it writes nothing, in either store, and the handler
// must not tell the user their note is ready (terminal-hooks onReady, the push).
// The repo side is tested elsewhere; this runs the real handler.
const require = createRequire(import.meta.url);
// The handler require()s @algominutes/db (TypeScript; tsx runs it in the image).
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const handler = require('../../services/summarizer/src/handler.js');
const terminalHooks = require('../../services/summarizer/src/terminal-hooks.js');
const realOnReady = terminalHooks.onReady;

const noop = () => {};
const warns: string[] = [];
const log = { info: noop, error: noop, warn: (_o: unknown, m: string) => void warns.push(m), child: () => log };
const readyCalls: unknown[] = [];

beforeEach(async () => {
  await resetDb();
  warns.length = 0;
  readyCalls.length = 0;
  terminalHooks.onReady = async (args: unknown) => void readyCalls.push(args);
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  await seedNote('n1', 'ws-a', 'alice');
  await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 1 WHERE id = 'n1'`);
  await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('n1', 0, 1000, 'We agreed to ship on Friday.')`);
});
afterAll(async () => {
  terminalHooks.onReady = realOnReady;
  await handler.pool().end();
  await pool.end();
  await repo.getPool().end();
});

const deps = (onCall: () => Promise<void>) => ({
  log, traceId: 't',
  sharedIntelligence: require('@algominutes/ai/intelligence.cjs'),
  sharedTemplates: require('@algominutes/ai/summary-templates.cjs'),
  sharedRedaction: require('@algominutes/ai/redaction.cjs'),
  geminiCall: {
    callGeminiWithLadder: async () => {
      await onCall();
      return { model: 'gemini-3.5-flash', rawText: JSON.stringify({ gist: 'Ship Friday.', actionItems: [], keyDecisions: ['Ship on Friday'] }) };
    },
  },
});

describe('summarizer: a run superseded during its Gemini call', () => {
  it('writes nothing and skips onReady (no "ready" push)', async () => {
    // A regenerate is claimed while Gemini is working: the generation moves on.
    const bump = async () => { await pool.query(`UPDATE notes SET summary_generation = 2 WHERE id = 'n1'`); };
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(bump));
    expect(readyCalls).toEqual([]);
    expect(warns).toContain('summarizer_generation_superseded');
    expect(await count(`SELECT 1 FROM summaries WHERE note_id = 'n1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1' AND status = 'summarizing'`)).toBe(1);
  });

  it('a note deleted during the call: nothing written, no onReady', async () => {
    const del = async () => { await pool.query(`DELETE FROM notes WHERE id = 'n1'`); };
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(del));
    expect(readyCalls).toEqual([]);
    expect(warns).toContain('summarizer_note_gone_before_write');
  });
});
