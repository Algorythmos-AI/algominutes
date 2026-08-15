/**
 * A10 compliance repo: data retention (#5), terms/privacy acceptance (#3),
 * in-app support requests (#4).
 */
import { getPool, isPostgresEnabled } from './db.js';

// ── Retention (#5) ───────────────────────────────────────────────────────────
export async function setRetentionDays(uid: string, days: number | null): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(`UPDATE users SET retention_days = $2 WHERE uid = $1`, [uid, days]);
}
export async function getRetentionDays(uid: string): Promise<number | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query(`SELECT retention_days FROM users WHERE uid = $1`, [uid]);
  return rows[0]?.retention_days ?? null;
}

// ── Terms/Privacy acceptance (#3) ────────────────────────────────────────────
export async function recordTermsAcceptance(input: {
  uid: string;
  termsVersion: string;
  privacyVersion: string;
  ipHash?: string | null;
  appVersion?: string | null;
  platform?: string | null;
}): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `INSERT INTO terms_acceptance (uid, terms_version, privacy_version, ip_hash, app_version, platform)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.uid, input.termsVersion, input.privacyVersion, input.ipHash ?? null, input.appVersion ?? null, input.platform ?? null],
  );
}

// ── Support requests (#4) — diagnostic context ONLY, never content ───────────
export async function createSupportRequest(input: {
  uid?: string | null;
  kind: 'contact' | 'bad_transcript' | 'bad_summary';
  message?: string | null;
  noteId?: string | null;
  appVersion?: string | null;
  device?: string | null;
  platform?: string | null;
}): Promise<{ id?: number }> {
  if (!isPostgresEnabled()) return {};
  const { rows } = await getPool().query(
    `INSERT INTO support_requests (uid, kind, message, note_id, app_version, device, platform)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.uid ?? null, input.kind, input.message ?? null, input.noteId ?? null, input.appVersion ?? null, input.device ?? null, input.platform ?? null],
  );
  return { id: rows[0]?.id };
}
export async function listSupportRequests(opts: { includeResolved?: boolean; limit?: number } = {}): Promise<unknown[]> {
  if (!isPostgresEnabled()) return [];
  const where = opts.includeResolved ? '' : 'WHERE resolved_at IS NULL';
  const { rows } = await getPool().query(
    `SELECT * FROM support_requests ${where} ORDER BY created_at DESC LIMIT $1`,
    [Math.min(opts.limit ?? 200, 1000)],
  );
  return rows;
}
