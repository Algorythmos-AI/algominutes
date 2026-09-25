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
import { lockNoteId } from './note-lock';

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

/** The note was deleted (its purge is still pending): nothing may be uploaded into it. */
export class NoteDeletedError extends Error {
  readonly code = 'NOTE_DELETED';
  constructor(noteId: string) {
    super(`note ${noteId} was deleted`);
    this.name = 'NoteDeletedError';
  }
}

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
      // The note lock first (the kickoff's and deleteNote's order). A deletion
      // either committed before this, and its purge row refuses the session, or
      // waits, then deletes this session's row and cancels its URI.
      await lockNoteId(client, input.noteId);
      const purging = await client.query(
        'SELECT 1 FROM storage_purges WHERE note_id = $1 AND workspace_id = $2 LIMIT 1',
        [input.noteId, input.workspaceId],
      );
      if (purging.rowCount) throw new NoteDeletedError(input.noteId);
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
      WHERE id = $1 AND uid = $2 AND expires_at > $3
        -- CLAUDE.md §1: still a member of the session's workspace (matters once
        -- workspaces are shared and membership can be revoked).
        AND EXISTS (SELECT 1 FROM workspace_members wm
                     WHERE wm.workspace_id = upload_sessions.workspace_id AND wm.uid = $2)`,
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

/**
 * Delete upload sessions past their expiry. GCS resumable sessions expire on
 * their own (a week), so an expired row is only a record of nothing.
 */
export async function deleteExpiredUploadSessions(now: Date = new Date()): Promise<number> {
  const { rowCount } = await getPool().query('DELETE FROM upload_sessions WHERE expires_at < $1', [now]);
  return rowCount ?? 0;
}
