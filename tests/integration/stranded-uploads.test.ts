import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, createUploadSession, markUploadCompleted, reportStrandedUploads } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

// RELEASE.md rev 11, L2 (H2d). The apps upload a recording, then ask /v1/process to run it. An iPhone app killed
// between the two left the audio in Cloud Storage and no note row in Postgres, so nothing server-side ever saw
// it: the sweep's stuck-note step reads notes, and there was none. /complete now records when an upload
// finished, and the sweep reports each one that no note followed within 30 minutes, once.
const MIN = 60_000;
const session = (noteId: string) => ({
  uid: 'alice', workspaceId: 'workspace_alice', noteId, storagePath: `recordings/workspace_alice/${noteId}.aac`,
  sessionUri: `https://storage.googleapis.com/upload/x?upload_id=${noteId}`, totalBytes: 10,
  expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
});

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('uploads that no note followed', () => {
  it('are reported once, 30 minutes after they completed, with what finds them', async () => {
    const id = await createUploadSession(session('lost'), quietLog);
    await markUploadCompleted({ id, uid: 'alice' });
    const soon = new Date(Date.now() + 29 * MIN);
    expect(await reportStrandedUploads({ now: soon })).toEqual([]);

    const later = new Date(Date.now() + 31 * MIN);
    const found = await reportStrandedUploads({ now: later });
    expect(found).toEqual([expect.objectContaining({ uid: 'alice', workspaceId: 'workspace_alice', noteId: 'lost', storagePath: 'recordings/workspace_alice/lost.aac' })]);
    expect(await reportStrandedUploads({ now: new Date(Date.now() + 60 * MIN) })).toEqual([]);
  });

  it("an upload whose note was kicked off, one never completed, or someone else's completion isn't reported", async () => {
    const ran = await createUploadSession(session('ran'), quietLog);
    await markUploadCompleted({ id: ran, uid: 'alice' });
    await seedNote('ran', 'workspace_alice', 'alice');
    await createUploadSession(session('unfinished'), quietLog);
    const other = await createUploadSession(session('notmine'), quietLog);
    await markUploadCompleted({ id: other, uid: 'mallory' });
    expect(await reportStrandedUploads({ now: new Date(Date.now() + 31 * MIN) })).toEqual([]);
  });

  it('an upload whose note was deleted before it ran is not reported', async () => {
    const id = await createUploadSession(session('gone'), quietLog);
    await markUploadCompleted({ id, uid: 'alice' });
    await pool.query(`INSERT INTO deleted_notes (note_id, workspace_id) VALUES ('gone', 'workspace_alice')`);
    expect(await reportStrandedUploads({ now: new Date(Date.now() + 31 * MIN) })).toEqual([]);
  });
});
