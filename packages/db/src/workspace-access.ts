/**
 * Identity + tenancy bootstrap shared by the repo writers that can be a new
 * user's FIRST write: queueing a note (notes-repo markQueued / markReady) and
 * starting an upload (upload-sessions-repo). Internal to @algominutes/db; the
 * index re-exports only WorkspaceBoundaryError (via notes-repo).
 */
import type { PoolClient } from 'pg';

export class WorkspaceBoundaryError extends Error {
  readonly code = 'WORKSPACE_BOUNDARY';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
  }
}

/** The account was deleted (account_deletions): it must not be re-created. */
export class AccountDeletedError extends Error {
  readonly code = 'ACCOUNT_DELETED';
  readonly status = 401;
  constructor(uid: string) {
    super(`account ${uid} was deleted`);
    this.name = 'AccountDeletedError';
  }
}

/**
 * Upsert the user row (an FK target for workspaces, notes, uploads).
 * users.email is NOT NULL, and Postgres enforces that while forming the row,
 * before ON CONFLICT. So a caller with no email claim (anonymous sign-in) gets
 * the `<uid>@firebase.local` placeholder. A real email, when present, always
 * wins and is never overwritten by the placeholder.
 */
export async function ensureUser(
  client: PoolClient,
  user: { uid: string; email?: string | null; name?: string | null },
): Promise<void> {
  // A deleted account stays deleted. Its ID token can still verify for up to
  // an hour, and this upsert would otherwise quietly bring the account back.
  const tomb = await client.query('SELECT 1 FROM account_deletions WHERE uid = $1', [user.uid]);
  if (tomb.rowCount) throw new AccountDeletedError(user.uid);
  await client.query(
    `INSERT INTO users (uid, email, display_name)
       VALUES ($1, COALESCE($2::text, $1 || '@firebase.local'), $3)
     ON CONFLICT (uid) DO UPDATE SET
       email        = COALESCE($2::text, users.email),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
    [user.uid, user.email || null, user.name || null],
  );
}

/**
 * The caller may write into `workspaceId` only if it is a brand-new workspace
 * (bootstrapped here with the caller as owner), or the caller is already a
 * member of it. A workspace row whose owner_uid is the caller but which is
 * missing the owner's membership row (legacy backfill) is healed. Anyone else
 * gets a WorkspaceBoundaryError: never add a stranger to an existing workspace.
 */
export async function ensureWorkspaceAccess(
  client: PoolClient,
  workspaceId: string,
  uid: string,
  name: string,
): Promise<void> {
  const created = await client.query(
    `INSERT INTO workspaces (id, owner_uid, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    [workspaceId, uid, name],
  );
  if (created.rowCount) {
    await client.query(
      `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, uid],
    );
    return;
  }
  const member = await client.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND uid = $2', [
    workspaceId,
    uid,
  ]);
  if (member.rowCount) return;
  const healed = await client.query(
    `INSERT INTO workspace_members (workspace_id, uid, role)
       SELECT id, owner_uid, 'owner' FROM workspaces WHERE id = $1 AND owner_uid = $2
       ON CONFLICT (workspace_id, uid) DO NOTHING
       RETURNING uid`,
    [workspaceId, uid],
  );
  if (!healed.rowCount) {
    throw new WorkspaceBoundaryError(`${uid} is not a member of workspace ${workspaceId}`);
  }
}

