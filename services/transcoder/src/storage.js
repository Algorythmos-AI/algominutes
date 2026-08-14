'use strict';

// Cloud Storage helpers. Cloud Run service auth is the bound
// service account; no credentials needed in code.

const fs = require('node:fs');
const path = require('node:path');

let _client = null;
function getClient() {
  if (_client) return _client;
  const { Storage } = require('@google-cloud/storage');
  _client = new Storage();
  return _client;
}

function bucket() {
  const name = process.env.GCS_BUCKET;
  if (!name) throw new Error('GCS_BUCKET env var not set');
  return getClient().bucket(name);
}

async function downloadToLocal(gcsPath, localPath) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  await bucket().file(gcsPath).download({ destination: localPath });
  return localPath;
}

async function uploadFromLocal(localPath, gcsPath, contentType) {
  await bucket().upload(localPath, {
    destination: gcsPath,
    metadata: { contentType: contentType || 'application/octet-stream' },
    resumable: false,
  });
  return gcsToUri(gcsPath);
}

function gcsToUri(gcsPath) {
  const name = process.env.GCS_BUCKET;
  return `gs://${name}/${gcsPath}`;
}

async function readBytes(gcsPath) {
  const [buf] = await bucket().file(gcsPath).download();
  return buf;
}

async function getSize(gcsPath) {
  const [meta] = await bucket().file(gcsPath).getMetadata();
  return Number(meta.size || 0);
}

/**
 * Delete every object under a prefix. Best-effort; never throws.
 *
 * Written for the chunked pipeline's intermediate FLAC files, which are raw
 * clinical audio and were never deleted by anything — not when the note was
 * deleted, not when the account was deleted, and not once transcription had
 * finished with them. Every consultation over ten minutes left its audio in
 * the bucket indefinitely.
 */
async function deletePrefix(prefix, log) {
  try {
    const [files] = await bucket().getFiles({ prefix });
    if (!files.length) return 0;
    const results = await Promise.allSettled(files.map((f) => f.delete()));
    let deleted = 0;
    for (const r of results) {
      // 404 means someone else already removed it, which is success here.
      if (r.status === 'fulfilled' || r.reason?.code === 404) deleted += 1;
    }
    const failed = results.length - deleted;
    if (log) log.info({ prefix, deleted, failed }, 'chunk_cleanup');
    return deleted;
  } catch (err) {
    // Cleanup failing must never fail the job — the transcript is already
    // safe in Postgres by the time this runs.
    if (log) log.error({ err: { message: err?.message }, prefix }, 'chunk_cleanup_failed');
    return 0;
  }
}

module.exports = {
  deletePrefix,
  downloadToLocal,
  uploadFromLocal,
  gcsToUri,
  readBytes,
  getSize,
  bucket,
};
