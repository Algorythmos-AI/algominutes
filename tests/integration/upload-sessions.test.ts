import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, createUploadSession, getUploadSession, WorkspaceBoundaryError } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, quietLog, count } from './helpers';

// Resumable upload sessions live server-side (migration 013). The uploadId used
// to BE the session (client-controlled base64 JSON), and the server PUT to the
// URI inside it: an SSRF plus a cross-workspace existence oracle. A session is
// now readable only by the uid that created it, and only while unexpired.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const session = (over: Record<string, unknown> = {}) => ({
  uid: 'alice',
  workspaceId: 'workspace_alice',
  noteId: 'note-1',
  storagePath: 'recordings/workspace_alice/note-1.m4a',
  sessionUri: 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=abc',
  totalBytes: 123_456_789,
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  ...over,
});

describe('upload sessions (server-side)', () => {
  it('round-trips for its owner; the uploadId is an opaque UUID', async () => {
    const id = await createUploadSession(session(), quietLog);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const got = await getUploadSession({ id, uid: 'alice' });
    expect(got).toMatchObject({ id, uid: 'alice', storagePath: 'recordings/workspace_alice/note-1.m4a', totalBytes: 123_456_789 });
  });

  it("another user's id reads as not found (no cross-account session access)", async () => {
    const id = await createUploadSession(session(), quietLog);
    expect(await getUploadSession({ id, uid: 'mallory' })).toBeNull();
  });

  it('an expired session reads as not found', async () => {
    const id = await createUploadSession(session({ expiresAt: new Date(Date.now() - 1000) }), quietLog);
    expect(await getUploadSession({ id, uid: 'alice' })).toBeNull();
  });

  it('a malformed or forged id (e.g. the old base64 JSON handle) is not found, never a DB error', async () => {
    const forged = Buffer.from(JSON.stringify({ sessionUri: 'http://169.254.169.254/', storagePath: 'x' })).toString('base64url');
    for (const id of [forged, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect(await getUploadSession({ id, uid: 'alice' })).toBeNull();
    }
  });

  it("bootstraps a first-time user's rows, and refuses someone else's workspace", async () => {
    const id = await createUploadSession(session({ uid: 'carol', workspaceId: 'workspace_carol', storagePath: 'recordings/workspace_carol/n.m4a' }), quietLog);
    expect(await getUploadSession({ id, uid: 'carol' })).not.toBeNull();
    await expect(createUploadSession(session({ uid: 'bob' }), quietLog)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect(await count(`SELECT 1 FROM upload_sessions WHERE uid = 'bob'`)).toBe(0);
  });

  it('account deletion removes the sessions (FK cascade)', async () => {
    await createUploadSession(session(), quietLog);
    await pool.query(`DELETE FROM users WHERE uid = 'alice'`);
    expect(await count(`SELECT 1 FROM upload_sessions WHERE uid = 'alice'`)).toBe(0);
  });
});
