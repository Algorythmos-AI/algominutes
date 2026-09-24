import pg from 'pg';

// A test-owned pool for fixtures and assertions. Code under test uses its own
// pools (the repo layer's singleton, the transcoder's injected client), all
// pointed at the same DATABASE_URL.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

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
