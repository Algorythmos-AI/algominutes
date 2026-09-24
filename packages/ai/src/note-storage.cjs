'use strict';

/**
 * The Cloud Storage objects that belong to one note, and their deletion.
 *
 * A note's content lives at `{recordings|imports|scans}/{workspaceId}/{noteId}`,
 * with or without an extension (see storage-paths.cjs and the clients'
 * StoragePaths). The chunked pipeline's scratch lives at
 * `transcoder/{noteId}/…`. Objects are listed by prefix, but deleted only on
 * an EXACT name match. A bare prefix would be wrong: `recordings/ws/note1`
 * also prefixes `recordings/ws/note10.m4a`, another note's audio. (The old
 * functions/ onNoteDeleted sweep had exactly that bug.)
 *
 * The bucket is passed in (a @google-cloud/storage Bucket), so this module has
 * no SDK dependency and tests can use a fake.
 */

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_ROOTS = ['recordings', 'imports', 'scans'];

/** [{ prefix, matches(name) }] for one note. Throws on a malformed id, so an empty or odd id can never widen a listing. */
function noteObjectSets({ workspaceId, noteId, includeScratch }) {
  // typeof first: String(null) is 'null', which the pattern would accept.
  if (typeof workspaceId !== 'string' || typeof noteId !== 'string' || !ID.test(workspaceId) || !ID.test(noteId)) {
    throw new Error('note-storage: invalid workspaceId/noteId');
  }
  const sets = CONTENT_ROOTS.map((root) => {
    const base = `${root}/${workspaceId}/${noteId}`;
    // The note's object, optionally with one extension; nothing else.
    return { prefix: base, matches: (name) => name === base || (name.startsWith(`${base}.`) && !name.slice(base.length).includes('/')) };
  });
  if (includeScratch) {
    const scratch = `transcoder/${noteId}/`;
    sets.push({ prefix: scratch, matches: (name) => name.startsWith(scratch) });
  }
  return sets;
}

/**
 * The note's recorded object, but only if its name is exactly this note's
 * (`{root}/{ws}/{noteId}[.ext]`). notes.storage_path comes from the client at
 * /v1/process and is checked only against the workspace prefix, so it could
 * name ANOTHER note's audio in the same workspace. Trusting it would delete
 * that note's audio.
 */
function ownedStoragePath(storagePath, workspaceId, noteId) {
  if (typeof storagePath !== 'string') return null;
  const sets = noteObjectSets({ workspaceId, noteId, includeScratch: false });
  return sets.some((s) => s.matches(storagePath)) ? storagePath : null;
}

/**
 * Delete every object of one note. Throws on a listing or deletion error, so
 * the caller keeps the purge for a retry; a missing object is not an error.
 * Returns the names it deleted.
 */
async function purgeNoteObjects({ bucket, workspaceId, noteId, storagePath, includeScratch }, log) {
  const names = new Set();
  for (const set of noteObjectSets({ workspaceId, noteId, includeScratch })) {
    const [files] = await bucket.getFiles({ prefix: set.prefix });
    for (const f of files) if (set.matches(f.name)) names.add(f.name);
  }
  const own = ownedStoragePath(storagePath, workspaceId, noteId);
  if (own) names.add(own);
  for (const name of names) {
    await bucket.file(name).delete({ ignoreNotFound: true });
  }
  if (log) log.info({ noteId, workspaceId, objects: names.size }, 'note_storage_purged');
  return [...names];
}

/**
 * Delete every content object of one WORKSPACE (account deletion): everything
 * under `{recordings|imports|scans}/{workspaceId}/`, including uploads that
 * never became a note. The trailing slash keeps `ws1` from matching `ws10`.
 * Throws on an error, so the caller can log it for a retry.
 */
async function purgeWorkspaceObjects({ bucket, workspaceId }, log) {
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) {
    throw new Error('note-storage: invalid workspaceId');
  }
  let n = 0;
  for (const root of CONTENT_ROOTS) {
    const [files] = await bucket.getFiles({ prefix: `${root}/${workspaceId}/` });
    for (const f of files) {
      await f.delete({ ignoreNotFound: true });
      n += 1;
    }
  }
  if (log) log.info({ workspaceId, objects: n }, 'workspace_storage_purged');
  return n;
}

/**
 * Cancel a GCS resumable-upload session, so nothing more can be uploaded
 * through its URI. GCS answers 499 to the cancel, and 404/410 once it's already
 * gone; all three are success. Only a storage.googleapis.com URI is ever
 * contacted (the same rule as the upload routes). Throws on anything else.
 */
async function cancelResumableUpload(sessionUri, fetchImpl = fetch) {
  let url;
  try { url = new URL(sessionUri); } catch (err) { throw new Error(`not a session uri: ${err.message}`); }
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') {
    throw new Error('refusing to cancel a non-GCS session uri');
  }
  const res = await fetchImpl(url.href, { method: 'DELETE', headers: { 'Content-Length': '0' } });
  if (![499, 404, 410, 200, 204].includes(res.status)) {
    throw new Error(`cancel resumable upload failed: HTTP ${res.status}`);
  }
}

module.exports = { purgeNoteObjects, purgeWorkspaceObjects, cancelResumableUpload, noteObjectSets, ownedStoragePath };
