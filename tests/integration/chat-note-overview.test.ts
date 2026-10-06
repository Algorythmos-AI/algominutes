import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// RELEASE.md rev 11, LM10: a chat about one note also sees that note's summary and chapters. Retrieval finds the
// excerpts nearest the question, which can't answer "what was this meeting about" on a 3-hour note. Real
// Postgres; two accounts, as every query that returns user data is tested (CLAUDE.md §1).
const require = createRequire(import.meta.url);
const { noteOverview, buildChatPrompt, handleChatStream } = require('../../services/api/src/routes/search-and-chat.cjs');
const readPool = require('@algominutes/ai/pg-query.cjs').pool();

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };
const CHAPTERS = [
  { startMs: 0, title: 'Budget', summary: 'The Q3 budget was agreed.' },
  { startMs: 3_600_000, title: 'Hiring', summary: 'Two roles open in Sydney.' },
];

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
  await seedUser('bob');
  await seedWorkspace('workspace_bob', 'bob');
  await pool.query(
    `INSERT INTO summaries (note_id, gist, long_summary, topics, model, chapters) VALUES ('n1', $1, $2, '[]', 'gemini-test', $3)`,
    ['A planning meeting.', 'The team planned the quarter.', JSON.stringify(CHAPTERS)],
  );
});
afterAll(async () => {
  await readPool.end();
  await pool.end();
});

describe('noteOverview', () => {
  it("returns the owner's note's summary and chapters, in order", async () => {
    const o = await noteOverview({ uid: 'alice', noteId: 'n1', log });
    expect(o.summary).toBe('A planning meeting.\n\nThe team planned the quarter.');
    expect(o.chapters).toEqual(CHAPTERS);
  });

  it('returns nothing to someone outside the note’s workspace', async () => {
    expect(await noteOverview({ uid: 'bob', noteId: 'n1', log })).toBeNull();
  });

  it('returns nothing for a note with no summary, a deleted note, or one whose run failed', async () => {
    await seedNote('n2', 'workspace_alice', 'alice');
    expect(await noteOverview({ uid: 'alice', noteId: 'n2', log })).toBeNull();
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
    expect(await noteOverview({ uid: 'alice', noteId: 'n1', log })).toBeNull();
    await pool.query(`UPDATE notes SET status = 'ready', deleted_at = NOW() WHERE id = 'n1'`);
    expect(await noteOverview({ uid: 'alice', noteId: 'n1', log })).toBeNull();
  });

  it('skips a malformed chapter and never returns more than the bound', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ startMs: i * 1000, title: `C${i}`, summary: 's' }));
    await pool.query(`UPDATE summaries SET chapters = $1 WHERE note_id = 'n1'`, [JSON.stringify([{ title: 'no time' }, null, ...many])]);
    const o = await noteOverview({ uid: 'alice', noteId: 'n1', log });
    expect(o.chapters).toHaveLength(40);
    expect(o.chapters[0].title).toBe('C0');
  });
});

describe('the chat prompt', () => {
  const hits = [{ noteId: 'n1', startMs: 5000, chunkText: 'We agreed the budget.' }];
  const overview = { summary: 'A planning meeting. Call Sam on 0412 345 678.', chapters: CHAPTERS };

  it('a chat about one note carries the overview before the excerpts, and says not to cite it', () => {
    const { prompt } = buildChatPrompt('What was this about?', hits, true, overview);
    expect(prompt).toContain('Overview of the whole meeting');
    expect(prompt).toContain('do not cite it with a number');
    expect(prompt).toContain('- (t=3600000ms) Hiring: Two roles open in Sydney.');
    expect(prompt.indexOf('Overview of the whole meeting')).toBeLessThan(prompt.indexOf('[1] (t=5000ms)'));
  });

  it('the overview is scrubbed like the excerpts are, and counted', () => {
    const { prompt, redactionCounts } = buildChatPrompt('q', hits, true, overview);
    expect(prompt).not.toContain('0412 345 678');
    expect(prompt).toMatch(/<<REDACTED:[A-Z_]+>>/);
    expect(Object.values(redactionCounts).reduce((a: number, b) => a + (b as number), 0)).toBeGreaterThan(0);
  });

  it('a chat across all notes, or a note with no overview, is as before', () => {
    const before = buildChatPrompt('q', hits, true).prompt;
    expect(buildChatPrompt('q', hits, true, null).prompt).toBe(before);
    expect(before).not.toContain('Overview');
    expect(buildChatPrompt('q', hits, false, overview).prompt).not.toContain('Overview');
  });

  it('is bounded however long the summary is', () => {
    const { prompt } = buildChatPrompt('q', [], true, { summary: 'x'.repeat(50_000), chapters: [] });
    expect(prompt.length).toBeLessThan(7000);
  });
});

describe('POST /v1/chat about one note', () => {
  const stream = () => {
    const out = { status: 200, written: '' };
    const res = { status(c: number) { out.status = c; return this; }, json() { return this; }, setHeader: noop, write(t: string) { out.written += t; }, end: noop };
    return { out, res };
  };
  const sse = () => ({
    ok: true, status: 200,
    body: (async function* () { yield new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}\n\n`); })(),
  });
  const ask = async (uid: string, body: object, deps: object = {}) => {
    const sent: string[] = [];
    const { out, res } = stream();
    await handleChatStream({
      uid, body, log, res,
      deps: {
        assertUnderDailyCap: async () => ({ ok: true }), embed: async () => { throw new Error('no embedder in this test'); },
        recordChat: async () => {}, authHeader: async () => 'Bearer t', project: 'p',
        fetchImpl: async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).contents[0].parts[0].text); return sse(); },
        ...deps,
      },
    });
    return { out, prompt: sent[0] };
  };

  // Staging, 2026-10-06: two chats failed outright on the model's first 429.
  describe('a busy model', () => {
    const busy = (status: number) => ({ ok: false, status, body: null });
    const answering = (statuses: number[]) => {
      const waits: number[] = [];
      let calls = 0;
      let counted = 0;
      const deps = {
        sleep: async (ms: number) => void waits.push(ms),
        recordChat: async () => void (counted += 1),
        fetchImpl: async () => {
          const status = statuses[calls] ?? 200;
          calls += 1;
          return status === 200 ? sse() : busy(status);
        },
      };
      return { deps, waits, calls: () => calls, counted: () => counted };
    };

    it('is asked again after 429 or 503, and the answer arrives; the chat is counted once', async () => {
      const m = answering([429, 503]);
      const { out } = await ask('alice', { query: 'q', noteId: 'n1' }, m.deps);
      expect(out.written).toContain('"text":"ok"');
      expect(out.written).not.toContain('event: error');
      expect(m.calls()).toBe(3);
      expect(m.waits).toEqual([1000, 3000]);
      expect(m.counted()).toBe(1);
    });

    it('still busy after two more tries: the chat says it failed, and stops asking', async () => {
      const m = answering([429, 429, 429, 429]);
      const { out } = await ask('alice', { query: 'q', noteId: 'n1' }, m.deps);
      expect(out.written).toContain('event: error');
      expect(m.calls()).toBe(3);
    });

    it('a refusal that is not "busy" is not asked again', async () => {
      const m = answering([400]);
      const { out } = await ask('alice', { query: 'q', noteId: 'n1' }, m.deps);
      expect(out.written).toContain('event: error');
      expect(m.calls()).toBe(1);
      expect(m.waits).toEqual([]);
    });
  });

  it("sends the model the note's overview", async () => {
    const { prompt } = await ask('alice', { query: 'What was this about?', noteId: 'n1' });
    expect(prompt).toContain('Summary: A planning meeting.');
    expect(prompt).toContain('Hiring');
  });

  it('an overview that can’t be read leaves the chat working, without it', async () => {
    const { out, prompt } = await ask('alice', { query: 'q', noteId: 'n1' }, { noteOverview: async () => { throw new Error('boom'); } });
    expect(out.written).toContain('ok');
    expect(prompt).not.toContain('Overview');
  });

  it('someone outside the workspace gets 404, and the model is asked nothing', async () => {
    const { out, prompt } = await ask('bob', { query: 'q', noteId: 'n1' });
    expect(out.status).toBe(404);
    expect(prompt).toBeUndefined();
  });

  it('a chat across all notes carries no overview', async () => {
    const { prompt } = await ask('alice', { query: 'budget' });
    expect(prompt).not.toContain('Overview');
  });
});
