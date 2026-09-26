import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// POST /v1/notes/audio-url signs a short GET for a note's audio, only for a
// member of the note's workspace and only for the note's own object.
const signed: Array<{ name: string; opts: any }> = [];
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (name: string) => ({
        getSignedUrl: async (opts: unknown) => { signed.push({ name, opts }); return [`https://storage.googleapis.com/signed/${name}`]; },
      }),
    }),
  }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { noteAudioUrlRoute, AUDIO_URL_TTL_MS } = await import('../../services/api/src/routes/note-audio.js');

beforeEach(async () => {
  await resetDb();
  signed.length = 0;
  await seedUser('alice');
  await seedUser('eve');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-e', 'eve');
  await seedNote('n1', 'ws-a', 'alice');
  await pool.query(`UPDATE notes SET storage_path = 'recordings/ws-a/n1.m4a' WHERE id = 'n1'`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function audioUrl(uid: string, body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any, headers: {} as Record<string, string> };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
    set(k: string, v: string) { out.headers[k] = v; return this; },
  };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await noteAudioUrlRoute({ uid, log, body }, res);
  return out;
}

describe('POST /v1/notes/audio-url', () => {
  it("signs a 15-minute GET for the member's own note, uncached", async () => {
    const before = Date.now();
    const out = await audioUrl('alice', { noteId: 'n1', workspaceId: 'ws-a' });
    expect(out.status).toBe(200);
    expect(out.body.url).toBe('https://storage.googleapis.com/signed/recordings/ws-a/n1.m4a');
    expect(signed).toEqual([{ name: 'recordings/ws-a/n1.m4a', opts: expect.objectContaining({ version: 'v4', action: 'read' }) }]);
    expect(signed[0]!.opts.expires).toBeGreaterThanOrEqual(before + AUDIO_URL_TTL_MS);
    expect(Date.parse(out.body.expiresAt)).toBe(signed[0]!.opts.expires);
    expect(out.headers['Cache-Control']).toBe('no-store');
  });

  it("another user gets 404, even naming the right workspace, and nothing is signed", async () => {
    expect((await audioUrl('eve', { noteId: 'n1', workspaceId: 'ws-a' })).status).toBe(404);
    expect((await audioUrl('eve', { noteId: 'n1', workspaceId: 'ws-e' })).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it("a storage_path naming another note's object is never signed", async () => {
    await pool.query(`UPDATE notes SET storage_path = 'recordings/ws-a/other.m4a' WHERE id = 'n1'`);
    expect((await audioUrl('alice', { noteId: 'n1', workspaceId: 'ws-a' })).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it('a deleted note, or one with no audio, is 404; a bad body is 400', async () => {
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect((await audioUrl('alice', { noteId: 'n1', workspaceId: 'ws-a' })).status).toBe(404);
    await seedNote('yt', 'ws-a', 'alice'); // a YouTube note has no storage_path
    expect((await audioUrl('alice', { noteId: 'yt', workspaceId: 'ws-a' })).status).toBe(404);
    expect((await audioUrl('alice', { noteId: '../x', workspaceId: 'ws-a' })).status).toBe(400);
    expect(signed).toEqual([]);
  });
});
