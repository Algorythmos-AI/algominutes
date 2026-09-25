import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { getPool, deleteNote, createUploadSession } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// An upload session for a note that was just deleted used to be minted and
// recorded anyway: the deletion had already run, so its purge never learned
// the new session's URI, and the upload could land after the purge. Now
// createUploadSession takes the note lock and refuses a note with a pending
// purge, and the route cancels the session it had just minted.
const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=new';
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: () => ({ createResumableUpload: async () => [SESSION] }) }) }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { createUploadSessionRoute } = await import('../../services/api/src/routes/uploads.js');

const fs = { doc: () => ({ delete: async () => {} }) } as never;
const cancels: string[] = [];

beforeEach(async () => {
  await resetDb();
  cancels.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: { method: string }) => {
    if (init?.method === 'DELETE') cancels.push(url);
    return { status: 499 };
  });
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const session = (noteId: string) => ({
  uid: 'alice', workspaceId: 'workspace_alice', noteId, storagePath: `recordings/workspace_alice/${noteId}.m4a`,
  sessionUri: SESSION, totalBytes: 10, expiresAt: new Date(Date.now() + 3_600_000),
});

async function upload(noteId: string) {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await createUploadSessionRoute({
    uid: 'alice', log,
    body: { noteId, workspaceId: 'workspace_alice', fileName: 'a.m4a', contentType: 'audio/mp4', totalBytes: 10 },
  }, res);
  return out;
}

describe('an upload session for a deleted note', () => {
  it('the repo refuses it while the purge is pending, and records nothing', async () => {
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'workspace_alice', uid: 'alice' }, quietLog);
    await expect(createUploadSession(session('n1'), quietLog)).rejects.toMatchObject({ code: 'NOTE_DELETED' });
    expect(await count(`SELECT 1 FROM upload_sessions`)).toBe(0);
  });

  it('the route answers 404 and cancels the session it had just minted', async () => {
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'workspace_alice', uid: 'alice' }, quietLog);
    expect(await upload('n1')).toEqual({ status: 404, body: { error: 'Note not found' } });
    expect(cancels).toEqual([SESSION]);
    expect(await count(`SELECT 1 FROM upload_sessions`)).toBe(0);
  });

  it('a live note still gets its session, and nothing is cancelled', async () => {
    expect((await upload('n1')).status).toBe(200);
    expect(cancels).toEqual([]);
    expect(await count(`SELECT 1 FROM upload_sessions WHERE note_id = 'n1'`)).toBe(1);
  });

  it('a session recorded before the deletion is cancelled by its purge (the other order)', async () => {
    expect((await upload('n1')).status).toBe(200);
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'workspace_alice', uid: 'alice' }, quietLog);
    expect((await pool.query(`SELECT upload_session_uris FROM storage_purges`)).rows).toEqual([{ upload_session_uris: [SESSION] }]);
  });
});
