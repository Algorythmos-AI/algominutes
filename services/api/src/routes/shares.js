// POST /v1/shares/create  and  POST /v1/shares/revoke — share-link lifecycle.
//
// Ported from functions/index.js `exports.shareCreate` and
// `exports.shareRevoke` (BUILD-PLAN §3.1). Both are authenticated; the public
// READ of a share (`/v1/shares/read`) lives in shared-note.cjs.
//
// Repointed: the local pg-pool factory → @algominutes/db pg-query.cjs `pool()`
// (the membership + mint/revoke SQL runs on the SHARED pool); share-links +
// intelligence helpers → @algominutes/ai. The mint/revoke transactional SQL
// lives in @algominutes/ai share-links.cjs (createShareWithinTx /
// revokeShareWithinTx), exactly as the source used it.

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import shareLinksModule from '@algominutes/ai/share-links.cjs';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';

const { isValidId } = intelligenceModule;
const shareLinks = shareLinksModule;
const { pool, postgresEnabled } = pgQueryModule;

// Where a share link points. Deliberately a constant — this value is the
// hosting origin, which is fixed for the project and already hardcoded
// client-side. NOT renamed: the wassup→algominutes rename is a later phase.
const SHARE_BASE_URL = 'https://wassup-meeting.web.app';

// ── shareCreate ────────────────────────────────────────────────────────
// The raw token is returned HERE AND NOWHERE ELSE. Only sha256(token) is
// stored, so this response is the single moment it exists in the clear —
// which is also why it is never logged.
export async function shareCreateRoute(req, res) {
  const baseLog = req.log;
  const uid = req.uid;

  const { noteId, workspaceId } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let opts;
  try {
    opts = shareLinks.sanitizeShareRequest(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const log = baseLog.child({ uid, userId: uid, noteId, workspaceId });
  if (!postgresEnabled()) {
    return res.status(503).json({ error: 'Sharing is unavailable until Postgres is provisioned.' });
  }

  const client = await pool().connect();
  try {
    // Membership join, not just the naming check — the same shape every
    // other reader uses, so a shared workspace behaves consistently.
    const owned = await client.query(
      `SELECT n.id FROM notes n
         JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
        WHERE n.id = $1 AND wm.uid = $2 AND n.workspace_id = $3 AND n.deleted_at IS NULL`,
      [noteId, uid, workspaceId],
    );
    if (!owned.rows.length) {
      log.info({}, 'share_create_not_found');
      return res.status(404).json({ error: 'Note not found' });
    }

    const raw = shareLinks.mintToken();
    const created = await shareLinks.createShareWithinTx(client, {
      noteId, uid, tokenHash: shareLinks.hashToken(raw), scope: opts.scope, hours: opts.hours,
    });

    // shareId and expiry are logged; the token never is.
    log.info({ shareId: created.id, scope: opts.scope, hours: opts.hours }, 'share_created');
    return res.status(200).json({
      shareId: created.id,
      token: raw,
      url: `${SHARE_BASE_URL}/s/${raw}`,
      scope: opts.scope,
      expiresAt: created.expiresAt,
    });
  } finally {
    client.release();
  }
}

// ── shareRevoke ────────────────────────────────────────────────────────
export async function shareRevokeRoute(req, res) {
  const baseLog = req.log;
  const uid = req.uid;

  const { noteId, workspaceId, shareId } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId) || !shareId) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const log = baseLog.child({ uid, userId: uid, noteId, workspaceId });
  if (!postgresEnabled()) {
    return res.status(503).json({ error: 'Sharing is unavailable until Postgres is provisioned.' });
  }

  const client = await pool().connect();
  try {
    const changed = await shareLinks.revokeShareWithinTx(client, { shareId, noteId, uid });
    // Idempotent: revoking an already-revoked link is success, not an error.
    // Failing the second click would push people toward deleting the note.
    log.info({ shareId, changed }, 'share_revoked');
    return res.status(200).json({ ok: true, revoked: changed });
  } finally {
    client.release();
  }
}
