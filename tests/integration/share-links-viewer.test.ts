import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedNote, seedUser, seedWorkspace } from './helpers';
// @ts-expect-error: plain ESM module, no type declarations
import { shareCreateRoute } from '../../services/api/src/routes/shares.js';

// RELEASE.md PR 29: a share link opens the web app's viewer (/app/s/<token>) on the viewer's host, where
// the web app is public (the beta's), not the public site's placeholder page. Real Postgres.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
async function create(env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const out = { status: 200, body: undefined as any };
    const res: any = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
    await shareCreateRoute({ log, uid: 'alice', body: { noteId: 'n1', workspaceId: 'workspace_alice' } }, res);
    return out;
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('a share link', () => {
  it("opens the web app's viewer on the viewer's host", async () => {
    const out = await create({ SHARE_VIEWER_ORIGIN: 'https://beta.example.test' });
    expect(out.status).toBe(200);
    expect(out.body.url).toBe(`https://beta.example.test/app/s/${out.body.token}`);
  });

  it("opens on the public site's app when no viewer host is set", async () => {
    const out = await create({ PUBLIC_SITE_URL: 'https://site.example.test' });
    expect(out.body.url).toBe(`https://site.example.test/app/s/${out.body.token}`);
  });
});
