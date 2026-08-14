'use strict';

// Normalises the two accepted input shapes into a single Buffer:
//
//   { bytesBase64: "<base64>" }   — uploaded bytes inline (small files)
//   { storagePath: "gs://.../x" } — a Cloud Storage reference (the common
//                                   path: the client already uploaded to GCS)
//
// This mirrors the transcoder's kickoff payload, which likewise accepts
// either an inline source or a storagePath. Text extraction is a pure
// function of these bytes, which is what makes every endpoint idempotent:
// the same input always yields the same output, so no dedupe key or written
// state is required (see README "Idempotency").

const MAX_INLINE_BYTES = 24 * 1024 * 1024; // 24 MiB — see express json limit note in index.js

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function readInput(body, deps) {
  if (!body || typeof body !== 'object') throw badRequest('missing request body');

  if (typeof body.bytesBase64 === 'string' && body.bytesBase64.length) {
    const buf = Buffer.from(body.bytesBase64, 'base64');
    if (!buf.length) throw badRequest('bytesBase64 decoded to zero bytes');
    if (buf.length > MAX_INLINE_BYTES) {
      throw badRequest(`inline payload exceeds ${MAX_INLINE_BYTES} bytes; upload to storage and pass storagePath`);
    }
    return buf;
  }

  if (typeof body.storagePath === 'string' && body.storagePath.length) {
    return deps.storage.readBytes(body.storagePath);
  }

  throw badRequest('provide either bytesBase64 or storagePath');
}

module.exports = { readInput, MAX_INLINE_BYTES };
