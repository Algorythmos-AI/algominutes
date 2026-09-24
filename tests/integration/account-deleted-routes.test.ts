import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool, deleteAccountData } from '@algominutes/db';
import { pool, resetDb, seedUser, quietLog } from './helpers';

// A deleted account's ID token still verifies for up to an hour. The upload
// route must refuse it BEFORE minting a GCS resumable session, since that URL
// is a capability to write objects after the account is gone.
const minted: string[] = [];
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (name: string) => ({
        createResumableUpload: async () => { minted.push(name); return ['https://storage.googleapis.com/upload/session']; },
      }),
    }),
  }),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken: async (t: string) => ({ uid: t }) }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { createUploadSessionRoute } = await import('../../services/api/src/routes/uploads.js');
// @ts-expect-error: plain ESM module, no type declarations
const { authMiddleware } = await import('../../services/api/src/middleware/auth.js');

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  minted.length = 0;
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function upload(uid: string) {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await createUploadSessionRoute({
    uid, log,
    body: { noteId: 'n1', workspaceId: `workspace_${uid}`, fileName: 'a.m4a', contentType: 'audio/mp4', totalBytes: 10 },
  }, res);
  return out;
}

describe('routes and a deleted account', () => {
  it('a live account gets an upload session', async () => {
    expect((await upload('alice')).status).toBe(200);
    expect(minted).toEqual(['recordings/workspace_alice/n1.m4a']);
  });

  it('a deleted account gets 401, and no GCS session is minted', async () => {
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await upload('alice')).toEqual({ status: 401, body: { error: 'account_deleted' } });
    expect(minted).toEqual([]);
  });

  // Every authenticated route: a deleted account's still-valid token gets 401.
  it('the auth middleware refuses a deleted account on every route', async () => {
    const run = async (uid: string) => {
      const out = { status: 0, body: undefined as any, next: false };
      const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
      const noop = () => {};
      const log = { info: noop, warn: noop, error: noop, child: () => log };
      await authMiddleware({ headers: { authorization: `Bearer ${uid}` }, log }, res, () => { out.next = true; });
      return out;
    };
    expect((await run('alice')).next).toBe(true);
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await run('alice')).toEqual({ status: 401, body: { error: 'account_deleted' }, next: false });
  });
});
