/**
 * Resumable upload sessions (POST /v1/uploads and its status/complete routes),
 * kept server-side (migration 013).
 *
 * The uploadId handed to clients is this table's random UUID. The session URI
 * and storage path live here, minted by GCS and by the server, and are read
 * back only for the uid that created them, while unexpired. (Previously the
 * uploadId WAS the session, as client-controlled base64 JSON, and the server
 * PUT to whatever URI it contained: an SSRF plus a cross-workspace
 * existence oracle.)
 */
import { getPool, isPostgresEnabled, withTx } from './db';
import { ensureUser, ensureWorkspaceAccess } from './workspace-access';

export interface UploadSession {
  id: string;
  uid: string;
  workspaceId: string;
  noteId: string;
  storagePath: string;
  sessionUri: string;
  totalBytes: number;
  expiresAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UploadSessionsUnavailableError extends Error {
  constructor() {
    super('upload sessions need Postgres (WRITE_POSTGRES=true)');
    this.name = 'UploadSessionsUnavailableError';
  }
}

/**
 * Record a session GCS just minted. It may be a new user's first write, so it
 * ensures the user and workspace rows (and the caller's access to the
 * workspace) in the same transaction. Returns the opaque uploadId.
 */
export async function createUploadSession(
  input: Omit<UploadSession, 'id'> & { email?: string | null; name?: string | null },
  log: { error: (o: any, m?: string) => void },
): Promise<string> {
  if (!isPostgresEnabled()) throw new UploadSessionsUnavailableError();
  return withTx(
    async (client) => {
      await ensureUser(client, { uid: input.uid, email: input.email, name: input.name });
      await ensureWorkspaceAccess(
        client,
        input.workspaceId,
        input.uid,
        input.name ? `${input.name}'s Workspace` : 'My Workspace',
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO upload_sessions (uid, workspace_id, note_id, storage_path, session_uri, total_bytes, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [input.uid, input.workspaceId, input.noteId, input.storagePath, input.sessionUri, input.totalBytes, input.expiresAt],
      );
      return rows[0]!.id;
    },
    { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
  );
}

/**
 * The caller's own, unexpired session, or null. Returns null (never throws)
 * for a malformed id, one that doesn't exist, belongs to someone else, or has
 * expired. Callers answer all four the same way, so a guess reveals nothing.
 */
export async function getUploadSession(input: { id: string; uid: string }, now: Date = new Date()): Promise<UploadSession | null> {
  if (!isPostgresEnabled()) throw new UploadSessionsUnavailableError();
  if (typeof input.id !== 'string' || !UUID.test(input.id)) return null;
  const { rows } = await getPool().query(
    `SELECT id, uid, workspace_id, note_id, storage_path, session_uri, total_bytes, expires_at
       FROM upload_sessions
      WHERE id = $1 AND uid = $2 AND expires_at > $3`,
    [input.id, input.uid, now],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    uid: r.uid,
    workspaceId: r.workspace_id,
    noteId: r.note_id,
    storagePath: r.storage_path,
    sessionUri: r.session_uri,
    totalBytes: Number(r.total_bytes),
    expiresAt: new Date(r.expires_at),
  };
}
