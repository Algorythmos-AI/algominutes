'use strict';

// Cloud Storage read helper. Cloud Run service auth is the bound service
// account; no credentials needed in code. Trimmed from the transcoder's
// storage.js — the extractor only ever READS source documents, it never
// writes back (extraction output is returned in the response / consumed by
// the caller), so upload/delete are deliberately absent.

let _client = null;
function getClient() {
  if (_client) return _client;
  const { Storage } = require('@google-cloud/storage');
  _client = new Storage();
  return _client;
}

function bucketFor(gcsPath) {
  // Accept both `gs://bucket/object` URIs and bare object paths (resolved
  // against GCS_BUCKET), mirroring how the transcoder addresses storage.
  if (gcsPath.startsWith('gs://')) {
    const withoutScheme = gcsPath.slice('gs://'.length);
    const slash = withoutScheme.indexOf('/');
    if (slash < 0) throw badRequest('gcs uri missing object path');
    return { bucket: withoutScheme.slice(0, slash), object: withoutScheme.slice(slash + 1) };
  }
  const name = process.env.GCS_BUCKET;
  if (!name) throw new Error('GCS_BUCKET env var not set and storagePath is not a gs:// uri');
  return { bucket: name, object: gcsPath };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Download an object into memory as a Buffer. Extraction inputs (a PDF, a
// DOCX, a photo) are single files well under Cloud Run's memory budget, so we
// read them whole rather than streaming to disk the way the audio pipeline
// must for multi-hour recordings.
async function readBytes(gcsPath) {
  const { bucket, object } = bucketFor(gcsPath);
  const [buf] = await getClient().bucket(bucket).file(object).download();
  return buf;
}

module.exports = { readBytes, bucketFor };
