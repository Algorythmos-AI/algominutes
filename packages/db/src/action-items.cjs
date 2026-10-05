'use strict';

// An action item's tick: done or open. Postgres only (the Firestore mirror carries the items as text; the note
// read, GET-shaped POST /v1/notes/read, is where clients get an item's id and status).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed action item id (they are UUIDs): checked before it reaches a uuid column, which would raise. */
function isActionItemId(value) {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Tick or untick one of a note's action items, for a member of the note's workspace. Returns the item's new
 * status, or null when there is no such item on a note the caller can reach (not found and not yours read the
 * same). Idempotent: ticking a ticked item changes nothing but answers the same.
 */
async function setActionItemDone(client, { noteId, workspaceId, uid, itemId, done }) {
  if (!isActionItemId(itemId)) return null;
  const { rows } = await client.query(
    `UPDATE action_items ai
        SET status = $5,
            completed_at = CASE WHEN $5 = 'done' THEN COALESCE(ai.completed_at, NOW()) ELSE NULL END
       FROM notes n
       JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.uid = $3
      WHERE ai.id = $4 AND ai.note_id = $1
        AND n.id = ai.note_id AND n.workspace_id = $2 AND n.deleted_at IS NULL
      RETURNING ai.id, ai.status`,
    [noteId, workspaceId, uid, itemId, done ? 'done' : 'open'],
  );
  return rows[0] ? { itemId: rows[0].id, status: rows[0].status } : null;
}

/**
 * Remove a note's action items and return the ticks to carry across a manual edit: for each item text, the
 * status it had. An edit replaces a note's rows, which used to mean every tick was lost by fixing a typo in the
 * summary. Matched by exact text, one for one (two identical items keep their own ticks, in order).
 *
 * The delete itself returns the rows, so there is no moment between reading the ticks and removing them: a
 * tick committed just before is carried, and one arriving after waits on the row and finds it gone (404; the
 * client reads the note again). Reading first and deleting second lost a tick that landed in between.
 */
async function takeTicksWithinTx(client, noteId) {
  const { rows } = await client.query(
    `DELETE FROM action_items WHERE note_id = $1
     RETURNING text, status, completed_at, position, created_at, id`,
    [noteId],
  );
  rows.sort((x, y) =>
    (x.position ?? Infinity) - (y.position ?? Infinity)
    || new Date(x.created_at) - new Date(y.created_at)
    || String(x.id).localeCompare(String(y.id)));
  const kept = new Map();
  for (const r of rows) {
    if (r.status === 'open') continue;
    if (!kept.has(r.text)) kept.set(r.text, []);
    kept.get(r.text).push({ status: r.status, completedAt: r.completed_at });
  }
  /** The tick for the next item with this text, or an open one. */
  return (text) => {
    const queue = kept.get(text);
    return queue && queue.length ? queue.shift() : { status: 'open', completedAt: null };
  };
}

module.exports = { isActionItemId, setActionItemDone, takeTicksWithinTx };
