import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The web app's upload session is created with the site's Origin, so GCS
// accepts the browser's PUTs to it; a native app's session gets no origin.
const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=web';
const created: Array<Record<string, unknown>> = [];
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: () => ({ createResumableUpload: async (opts: Record<string, unknown>) => { created.push(opts); return [SESSION]; } }) }) }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { createUploadSessionRoute } = await import('../../services/api/src/routes/uploads.js');

let savedOrigins: string | undefined;
beforeEach(async () => {
  await resetDb();
  created.length = 0;
  savedOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://algominutes.algorythmos.com,https://staging.algominutes.algorythmos.com';
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
});
afterEach(() => {
  if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = savedOrigins;
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function upload(origin?: string) {
  const out = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await createUploadSessionRoute({
    uid: 'alice', log, headers: origin ? { origin } : {},
    body: { noteId: 'n1', workspaceId: 'workspace_alice', fileName: 'a.webm', contentType: 'audio/webm', totalBytes: 10 },
  }, res);
  return out;
}

describe('an upload session for the browser', () => {
  it("is created with the site's origin", async () => {
    const r = await upload('https://staging.algominutes.algorythmos.com');
    expect(r.status).toBe(200);
    expect(created).toEqual([{ metadata: { contentType: 'audio/webm' }, origin: 'https://staging.algominutes.algorythmos.com' }]);
  });

  it('is created with no origin for a native app, or an origin the api refuses', async () => {
    await upload();
    await upload('https://evil.example');
    expect(created).toEqual([{ metadata: { contentType: 'audio/webm' } }, { metadata: { contentType: 'audio/webm' } }]);
  });
});
