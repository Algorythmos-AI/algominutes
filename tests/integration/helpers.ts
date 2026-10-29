import pg from 'pg';
import { createRequire } from 'node:module';

// A test-owned pool for fixtures and assertions. Code under test uses its own
// pools (the repo layer's singleton, the transcoder's injected client), all
// pointed at the same DATABASE_URL — and all built by the ONE shared config, so
// the suite honours PGSSLMODE exactly like production.
const { buildPgConfig } = createRequire(import.meta.url)('@algominutes/ai/pg-config.cjs');
// The fixture pool is the test's own, not a service's: exempt from a service
// connection budget (PG_POOL_MAX), so a test run with one caps only the code under test.
const { PG_POOL_MAX: _serviceBudget, ...fixtureEnv } = process.env;
export const pool = new pg.Pool(buildPgConfig({ max: 4 }, fixtureEnv));

// Tables that are seeded by migrations and must survive a reset.
const KEEP = new Set(['schema_migrations', 'plans']);

/** Empty every application table (keeping migration history + seeded plans). */
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((r) => r.tablename).filter((t) => !KEEP.has(t));
  if (tables.length) {
    await pool.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}

export async function seedUser(uid: string): Promise<void> {
  await pool.query(`INSERT INTO users (uid, email) VALUES ($1, $2)`, [uid, `${uid}@test.invalid`]);
}

/** A workspace owned by `ownerUid`, with the owner (and any extra members) enrolled. */
export async function seedWorkspace(id: string, ownerUid: string, members: string[] = []): Promise<void> {
  await pool.query(`INSERT INTO workspaces (id, owner_uid, name) VALUES ($1, $2, $3)`, [id, ownerUid, id]);
  await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner')`, [id, ownerUid]);
  for (const uid of members) {
    await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [id, uid]);
  }
}

export async function seedNote(
  id: string,
  workspaceId: string,
  authorUid: string,
  opts: { chunksTotal?: number | null } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO notes (id, workspace_id, author_uid, status, source_type, chunks_total)
       VALUES ($1, $2, $3, 'queued', 'recording', $4)`,
    [id, workspaceId, authorUid, opts.chunksTotal ?? null],
  );
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM (${sql}) q`, params);
  return Number(rows[0]!.n);
}

/** A silent logger for code under test that requires one. */
export const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

/** The kinds of the notices written for a note, oldest first (note_notices, the outbox). */
export async function noticeKinds(noteId: string): Promise<string[]> {
  const { rows } = await pool.query<{ kind: string }>('SELECT kind FROM note_notices WHERE note_id = $1 ORDER BY id', [noteId]);
  return rows.map((r) => r.kind);
}

/**
 * Waits until `want` backends are queued on a lock (pg_locks, NOT granted), polling for up to ~10 s, and returns how
 * many are. A fixed sleep loses this race under CI load (process-kickoff.test.ts, 2026-10-27). Assert the count, since
 * a race test proves nothing unless the racers really queued, but only once the lock is let go, so a miss fails the
 * test rather than hanging the next reset. Run it on the blocker's connection. pg_locks, not pg_stat_activity: the
 * latter is snapshotted per transaction, so a poll inside the blocker's would never move. At PG_POOL_MAX=1 a second
 * caller waits for a pool client, not the lock: size `want` to the code's pool.
 */
export async function lockWaiters(client: pg.ClientBase, want: number, locktype?: string): Promise<number> {
  let n = 0;
  for (let i = 0; i < 1000; i++) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND ($1::text IS NULL OR locktype = $1)`,
      [locktype ?? null],
    );
    n = rows[0]!.n;
    if (n >= want) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return n;
}
