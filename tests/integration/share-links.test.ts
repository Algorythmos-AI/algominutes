import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';
// @ts-expect-error: plain ESM route module, no type declarations
import { shareCreateRoute, shareListRoute, shareRevokeRoute } from '../../services/api/src/routes/shares.js';

// RELEASE.md rev 11, H20: a user sees the links they made for a note, and can revoke them, before share links
// are switched on. Through the real routes, against real Postgres; two accounts, as every new query that
// returns user data is tested (CLAUDE.md §1).
const require = createRequire(import.meta.url);
const apiPool = require('@algominutes/ai/pg-query.cjs').pool();

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
async function call(route: (req: unknown, res: unknown) => Promise<unknown>, uid: string, body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  await route({ uid, log, body }, res);
  return out;
}

beforeEach(async () => {
  process.env.PUBLIC_SITE_URL = 'https://algominutes.test';
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
  await seedUser('bob');
  await seedWorkspace('workspace_bob', 'bob');
});
afterAll(async () => {
  await apiPool.end();
  await pool.end();
  await getPool().end();
});

const note = { noteId: 'n1', workspaceId: 'workspace_alice' };

describe('POST /v1/shares/list', () => {
  it("lists the owner's links for the note, newest first, live or not, and never a token", async () => {
    const first = await call(shareCreateRoute, 'alice', { ...note, expiresInHours: 24 });
    const second = await call(shareCreateRoute, 'alice', { ...note, scope: 'summary' });
    expect([first.status, second.status]).toEqual([200, 200]);
    await call(shareRevokeRoute, 'alice', { ...note, shareId: first.body.shareId });

    const out = await call(shareListRoute, 'alice', note);
    expect(out.status).toBe(200);
    expect(out.body.shares.map((s: any) => [s.shareId, s.live, s.revokedAt != null])).toEqual([
      [second.body.shareId, true, false],
      [first.body.shareId, false, true],
    ]);
    expect(out.body.shares[0]).toMatchObject({ scope: 'summary', readCount: 0, lastReadAt: null });
    const text = JSON.stringify(out.body);
    expect(text).not.toContain(first.body.token);
    expect(text).not.toContain(second.body.token);
  });

  it('an expired link is listed as not live', async () => {
    const made = await call(shareCreateRoute, 'alice', { ...note, expiresInHours: 1 });
    await pool.query(`UPDATE shares SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [made.body.shareId]);
    const out = await call(shareListRoute, 'alice', note);
    expect(out.body.shares).toEqual([expect.objectContaining({ shareId: made.body.shareId, live: false, revokedAt: null })]);
  });

  it("another user sees none of them: their own workspace finds nothing, and the owner's is forbidden", async () => {
    await call(shareCreateRoute, 'alice', note);
    expect(await call(shareListRoute, 'bob', { noteId: 'n1', workspaceId: 'workspace_bob' })).toEqual({ status: 200, body: { shares: [] } });
    expect((await call(shareListRoute, 'bob', note)).status).toBe(403);
  });

  it("a member of the workspace sees only the links they made themselves", async () => {
    await call(shareCreateRoute, 'alice', note);
    await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ('workspace_alice', 'bob', 'member')`);
    await pool.query(`INSERT INTO shares (note_id, token_hash, permission, scope, expires_at, created_by_uid) VALUES ('n1', 'h-bob', 'view', 'both', NOW() + INTERVAL '1 day', 'bob')`);
    const out = await call(shareListRoute, 'alice', note);
    expect(out.body.shares).toHaveLength(1);
  });

  it('a deleted note lists nothing', async () => {
    await call(shareCreateRoute, 'alice', note);
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect((await call(shareListRoute, 'alice', note)).body).toEqual({ shares: [] });
  });

  it('refuses a missing note id', async () => {
    expect((await call(shareListRoute, 'alice', { workspaceId: 'workspace_alice' })).status).toBe(400);
  });
});
