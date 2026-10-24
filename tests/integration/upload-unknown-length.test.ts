import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { getPool, getUploadSession } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace } from './helpers';

// RELEASE.md PR 33 (R3): an upload session minted before its length is known (the web recorder uploads
// while it records), and the size cap checked at /complete on what actually arrived. Real Postgres; a
// stand-in for Cloud Storage.
const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=abc';
const object = { exists: true, size: 1000, deleted: false };
// What each session was opened with (plan rev 12 S4: a declared length is sent to Cloud Storage).
const opened: Array<{ metadata?: Record<string, unknown> }> = [];
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: () => ({
        createResumableUpload: async (opts: { metadata?: Record<string, unknown> }) => { opened.push(opts); return [SESSION]; },
        exists: async () => [object.exists],
        getMetadata: async () => [{ size: String(object.size) }],
        delete: async () => { object.deleted = true; object.exists = false; return [{}]; },
      }),
    }),
  }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { createUploadSessionRoute, completeUploadRoute, getUploadStatusRoute } = await import('../../services/api/src/routes/uploads.js');

const MAX = 500 * 1024 * 1024;
const probes: string[] = [];
beforeEach(async () => {
  await resetDb();
  Object.assign(object, { exists: true, size: 1000, deleted: false });
  probes.length = 0;
  opened.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
    probes.push(init.headers['Content-Range']);
    return { status: 308, headers: { get: (h: string) => (h.toLowerCase() === 'range' ? 'bytes=0-1048575' : null) } };
  });
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
async function call(route: (req: any, res: any) => Promise<unknown>, req: any) {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  await route({ uid: 'alice', log, ...req }, res);
  return out;
}
const create = (extra: Record<string, unknown> = {}) => call(createUploadSessionRoute, {
  body: { noteId: 'n1', workspaceId: 'workspace_alice', fileName: 'recording.webm', contentType: 'audio/webm', ...extra },
});

// Plan rev 12 S4: nothing bounded the bytes of an upload in progress. A session opened with its length makes Cloud
// Storage refuse any byte past it (X-Upload-Content-Length), so a declared upload can't grow past what was checked.
describe('an upload whose length is declared', () => {
  it('opens the Cloud Storage session with that length, so no more can be sent', async () => {
    const out = await create({ totalBytes: 734003 });
    expect(out.status).toBe(200);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.metadata).toMatchObject({ contentType: 'audio/webm', contentLength: 734003 });
  });

  it("one whose length isn't known yet is opened without one (the cap is checked at /complete)", async () => {
    await create();
    expect(opened[0]!.metadata).not.toHaveProperty('contentLength');
  });
});

describe('an upload whose length isn\'t known yet', () => {
  it('gets a session, recorded with no length, and the status probe asks GCS for "bytes */*"', async () => {
    const out = await create();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ sessionUri: SESSION, storagePath: 'recordings/workspace_alice/n1.webm' });
    const { rows } = await pool.query(`SELECT total_bytes FROM upload_sessions WHERE note_id = 'n1'`);
    expect(rows).toEqual([{ total_bytes: null }]);
    expect((await getUploadSession({ id: out.body.uploadId, uid: 'alice' }))?.totalBytes).toBeNull();
    const status = await call(getUploadStatusRoute, { params: { uploadId: out.body.uploadId } });
    expect(status.body).toMatchObject({ receivedBytes: 1048576, complete: false });
    expect(probes).toEqual(['bytes */*']);
  });

  it('once finished, the status probe reports what arrived, not 0', async () => {
    const out = await create();
    vi.stubGlobal('fetch', async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ size: '734003' }) }));
    const status = await call(getUploadStatusRoute, { params: { uploadId: out.body.uploadId } });
    expect(status.body).toMatchObject({ receivedBytes: 734003, complete: true });
    // An answer with no readable object still says complete, and never throws.
    vi.stubGlobal('fetch', async () => ({ status: 200, headers: { get: () => null }, json: async () => { throw new Error('not json'); } }));
    expect((await call(getUploadStatusRoute, { params: { uploadId: out.body.uploadId } })).body).toMatchObject({ receivedBytes: 0, complete: true });
  });

  it('a declared length over the cap is still refused before any session', async () => {
    const out = await create({ totalBytes: MAX + 1 });
    expect(out.status).toBe(413);
    expect((await pool.query(`SELECT 1 FROM upload_sessions`)).rowCount).toBe(0);
  });
});

describe('/complete', () => {
  it('checks what arrived: over the cap, the object is deleted and the upload refused', async () => {
    const { body } = await create();
    object.size = MAX + 1;
    const out = await call(completeUploadRoute, { params: { uploadId: body.uploadId } });
    expect(out.status).toBe(413);
    expect(object.deleted).toBe(true);
  });

  it('a declared length is only the client\'s word: what arrived over the cap is refused too', async () => {
    const { body } = await create({ totalBytes: 1000 });
    object.size = MAX + 1;
    expect((await call(completeUploadRoute, { params: { uploadId: body.uploadId } })).status).toBe(413);
    expect(object.deleted).toBe(true);
  });

  it('exactly at the cap is allowed', async () => {
    const { body } = await create();
    object.size = MAX;
    expect((await call(completeUploadRoute, { params: { uploadId: body.uploadId } })).status).toBe(200);
    expect(object.deleted).toBe(false);
  });

  it('within the cap, completes; with nothing there yet, says so', async () => {
    const { body } = await create();
    expect(await call(completeUploadRoute, { params: { uploadId: body.uploadId } })).toMatchObject({ status: 200, body: { complete: true, storagePath: 'recordings/workspace_alice/n1.webm' } });
    object.exists = false;
    expect((await call(completeUploadRoute, { params: { uploadId: body.uploadId } })).status).toBe(409);
    expect(object.deleted).toBe(false);
  });
});
