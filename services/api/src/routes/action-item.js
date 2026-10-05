// POST /v1/notes/action-items/status: tick or untick one of a note's action items.
//
// Postgres only: the tick is a column on the item's row, read back by POST /v1/notes/read. The Firestore mirror
// carries a note's action items as text and isn't touched. Membership is checked in the same statement as the
// write, so a tick can't land on a note the caller can't reach.

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import actionItemsModule from '@algominutes/db/action-items.cjs';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';

const { isValidId } = intelligenceModule;
const { isActionItemId, setActionItemDone } = actionItemsModule;
const { pool, postgresEnabled } = pgQueryModule;

export async function actionItemStatusRoute(req, res) {
  const uid = req.uid;
  const { noteId, workspaceId, itemId, done } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId) || !isActionItemId(itemId) || typeof done !== 'boolean') {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }
  const log = req.log.child({ uid, userId: uid, noteId, workspaceId });
  if (!postgresEnabled()) {
    return res.status(503).json({ error: 'Action items are unavailable until Postgres is provisioned.' });
  }

  const client = await pool().connect();
  try {
    const item = await setActionItemDone(client, { noteId, workspaceId, uid, itemId, done });
    if (!item) {
      log.info({ itemId }, 'action_item_not_found');
      // 404 for both "no such item" and "not yours", as the note read answers.
      return res.status(404).json({ error: 'Action item not found' });
    }
    log.info({ itemId, status: item.status }, 'action_item_status_set');
    return res.status(200).json({ ok: true, noteId, itemId: item.itemId, status: item.status });
  } catch (err) {
    log.error({ err, itemId }, 'action_item_status_failed');
    return res.status(500).json({ error: 'Could not save that. Please try again.' });
  } finally {
    client.release();
  }
}
