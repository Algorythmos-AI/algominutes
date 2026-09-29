import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A recording refused for its length or the minutes left is the user's, not a pipeline fault: it's logged
// note_refused, which the note_failed alert and SLO 3 don't count (RELEASE.md PR 15b). And a queued run is
// stamped queued_at, which SLO 4 is timed from. Real Postgres.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const { markNoteFailed } = require('@algominutes/db/note-terminal.cjs');

const fsStub = { doc: () => ({ update: async () => {} }) };
const events: Array<{ level: string; msg: string }> = [];
const at = (level: string) => (_o: unknown, msg: string) => void events.push({ level, msg });
const log: any = { info: at('info'), warn: at('warn'), error: at('error'), child: () => log };
const fail = (extra: Record<string, unknown> = {}) => markNoteFailed({
  pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'too long', log, event: 't', enqueueNotice: async () => {}, ...extra,
});

beforeEach(async () => {
  events.length = 0;
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
});
afterAll(async () => {
  await pool.end();
  await repo.getPool().end();
});

describe('a refused recording', () => {
  it('is logged note_refused (a warning), never note_failed', async () => {
    const r = await fail({ refusal: true });
    expect(r.failed).toBe(true);
    expect(events).toContainEqual({ level: 'warn', msg: 'note_refused' });
    expect(events.map((e) => e.msg)).not.toContain('note_failed');
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('error');
  });

  it('a pipeline failure is still note_failed', async () => {
    await fail();
    expect(events).toContainEqual({ level: 'error', msg: 'note_failed' });
    expect(events.map((e) => e.msg)).not.toContain('note_refused');
  });

  it("a refusal Postgres couldn't take is note_failed: nothing marked it", async () => {
    const broken = { connect: async () => { throw new Error('pg down'); } };
    await markNoteFailed({ pool: broken, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'too long', log, event: 't', refusal: true, enqueueNotice: async () => {} });
    expect(events).toContainEqual({ level: 'error', msg: 'note_failed' });
  });
});

describe('a queued run', () => {
  it('is stamped queued_at, again on each new run', async () => {
    // The note's doc, as a client wrote it before the kickoff.
    const doc = { authorId: 'u', status: 'uploading' } as Record<string, unknown>;
    const fs = { doc: () => ({ get: async () => ({ exists: true, data: () => doc }), update: async (v: Record<string, unknown>) => void Object.assign(doc, v) }) };
    const queue = () => repo.markQueued(fs as never, { noteId: 'n2', workspaceId: 'ws', authorUid: 'u', sourceType: 'recording', storagePath: 'recordings/ws/n2.m4a' } as never, log);
    await queue();
    const first = (await pool.query(`SELECT queued_at FROM notes WHERE id = 'n2'`)).rows[0].queued_at;
    expect(first).toBeInstanceOf(Date);
    await pool.query(`UPDATE notes SET status = 'error', queued_at = queued_at - INTERVAL '1 hour' WHERE id = 'n2'`);
    await queue();
    const second = (await pool.query(`SELECT queued_at FROM notes WHERE id = 'n2'`)).rows[0].queued_at;
    expect(second.getTime()).toBeGreaterThan(first.getTime() - 3600_000 + 1000);
  });
});
