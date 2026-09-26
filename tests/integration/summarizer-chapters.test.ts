import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A long recording's summary gets chapters: the summarizer asks for them past
// 10 minutes, validates them against the recording, scrubs them, stores them
// with the summary and mirrors them. A cut-off answer is salvaged instead of
// failing the note. The real handler, on Postgres; Gemini and Firestore are fakes.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const mirrored: any[] = [];
const fsStub = { doc: () => ({ update: async (data: any) => void mirrored.push(data) }) };
for (const [id, exports] of [
  ['firebase-admin/firestore', { getFirestore: () => fsStub }],
  ['firebase-admin/app', { initializeApp: () => {}, getApps: () => [{}] }],
] as const) {
  const p = require.resolve(id);
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as never;
}
const handler = require('../../services/summarizer/src/handler.js');
const terminalHooks = require('../../services/summarizer/src/terminal-hooks.js');
const realOnReady = terminalHooks.onReady;

const noop = () => {};
const warns: string[] = [];
const log: any = { info: noop, error: noop, warn: (_o: unknown, m: string) => void warns.push(m), child: () => log };
const MIN = 60_000;

let request: any;
const deps = (answer: string) => ({
  log, traceId: 't',
  sharedIntelligence: require('@algominutes/ai/intelligence.cjs'),
  sharedTemplates: require('@algominutes/ai/summary-templates.cjs'),
  sharedRedaction: require('@algominutes/ai/redaction.cjs'),
  geminiCall: { callGeminiWithLadder: async (req: any) => { request = req; return { model: 'gemini-3.5-flash', rawText: answer }; } },
});
const lines = async (minutes: number[]) => {
  for (const m of minutes) {
    await pool.query(
      `INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('n1', $1, $2, $3)`,
      [m * MIN, m * MIN + 5000, `Talking at minute ${m}.`],
    );
  }
};
const stored = async () => (await pool.query(`SELECT gist, chapters FROM summaries WHERE note_id = 'n1'`)).rows[0];

beforeEach(async () => {
  await resetDb();
  warns.length = 0;
  mirrored.length = 0;
  request = undefined;
  terminalHooks.onReady = async () => {};
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  await seedNote('n1', 'ws-a', 'alice');
  await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 1 WHERE id = 'n1'`);
});
afterAll(async () => {
  terminalHooks.onReady = realOnReady;
  await handler.pool().end();
  await pool.end();
  await repo.getPool().end();
});

describe('summarizer chapters', () => {
  it('a 45-minute recording: asks for chapters, keeps the valid ones in order, scrubs them, stores and mirrors them', async () => {
    await lines([0, 15, 30, 44]);
    const answer = JSON.stringify({
      gist: 'Planning meeting.', actionItems: [], keyDecisions: [],
      chapters: [
        { start: '30:00', title: 'Budget', summary: 'Email cfo@example.com for sign-off.' },
        { start: '00:00', title: 'Intros', summary: 'Everyone joined.' },
        { start: '1:30:00', title: 'Past the end' },
        { start: '15:00', title: '' },
      ],
    });
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(answer));
    expect(request.parts[0].text).toContain('"chapters"');
    expect(request.generationConfig.responseSchema.properties.chapters).toBeDefined();
    expect(request.generationConfig.responseSchema.propertyOrdering.at(-1)).toBe('chapters');
    const { chapters } = await stored();
    expect(chapters.map((c: any) => [c.startMs, c.title])).toEqual([[0, 'Intros'], [30 * MIN, 'Budget']]);
    expect(chapters[1].summary).not.toContain('cfo@example.com');
    expect(mirrored[0]['summary.chapters']).toEqual(chapters);
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('ready');
  });

  it('a secret straddling the length cap is scrubbed whole, not cut into an unrecognisable fragment', async () => {
    await lines([0, 20]);
    const pad = 'x'.repeat(590);
    const answer = JSON.stringify({
      gist: 'g', actionItems: [], keyDecisions: [],
      chapters: [{ start: '00:00', title: 'Billing', summary: `${pad} card 4111 1111 1111 1111 end` }],
    });
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(answer));
    const [chapter] = (await stored()).chapters;
    expect(chapter.summary.length).toBeLessThanOrEqual(600);
    expect(chapter.summary).not.toMatch(/4111/);
  });

  it('a 2-minute recording: no chapter request, and none stored', async () => {
    await lines([0, 1, 2]);
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(JSON.stringify({ gist: 'Quick sync.', actionItems: [], keyDecisions: [] })));
    expect(request.parts[0].text).not.toContain('"chapters"');
    expect(request.generationConfig.responseSchema.properties.chapters).toBeUndefined();
    expect((await stored()).chapters).toEqual([]);
  });

  it('an answer cut off mid-chapters still lands the summary (salvaged), not a failed note', async () => {
    await lines([0, 20, 40]);
    const full = JSON.stringify({
      gist: 'Long review.', actionItems: ['Send notes'], keyDecisions: ['Go'],
      chapters: [{ start: '00:00', title: 'Start' }, { start: '20:00', title: 'Middle' }],
    });
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(full.slice(0, full.indexOf('"Middle"'))));
    expect(warns).toContain('summary_salvaged_partial');
    expect(await stored()).toEqual({ gist: 'Long review.', chapters: [{ startMs: 0, title: 'Start', summary: '' }] });
    expect(await repo.getPool().query(`SELECT count(*)::int AS n FROM action_items WHERE note_id = 'n1'`).then((r) => r.rows[0].n)).toBe(1);
  });
});

describe('summarizer prompt', () => {
  it("a speaker name the user typed is scrubbed before it reaches Gemini, like the words", async () => {
    await pool.query(
      `INSERT INTO transcript_lines (note_id, speaker_tag, speaker_name, start_ms, end_ms, text) VALUES
         ('n1', 1, 'jane@example.com', 0, 5000, 'Hello.'),
         ('n1', 2, 'Bob', 6000, 9000, 'Hi Jane.'),
         ('n1', 1, 'jane@example.com', 10000, 12000, 'Call me on 4111 1111 1111 1111.'),
         ('n1', 3, NULL, 13000, 15000, 'Bye.')`,
    );
    await handler.handle({ noteId: 'n1', workspaceId: 'ws-a' }, deps(JSON.stringify({ gist: 'Hellos.', actionItems: [], keyDecisions: [] })));
    const prompt = request.parts.map((p: any) => p.text).join('');
    expect(prompt).not.toContain('jane@example.com');
    expect(prompt).not.toMatch(/4111/);
    expect(prompt).toContain('<<REDACTED:EMAIL>>: Hello.');
    expect(prompt).toContain('Bob: Hi Jane.');
    expect(prompt).toContain('Speaker 3: Bye.');
  });
});
