'use strict';

// Ported from apps/web src/lib/documentText.ts -> extractDocxText().
//
// Browser -> Node change: mammoth accepts `{ arrayBuffer }` in the browser;
// in Node it accepts `{ buffer }` (a Node Buffer) directly, which is what the
// storage/input layer already hands us — no File/arrayBuffer round-trip.

const mammoth = require('mammoth');

async function extractDocx(buffer, { log } = {}) {
  if (log) log.info({ bytes: buffer.length }, 'extract_docx_start');
  // extractRawText drops styling and returns the document's plain text, which
  // is exactly what the downstream summarizer/embedder consume. mammoth
  // surfaces recoverable issues on `result.messages`; we log rather than throw
  // so a document with a couple of unsupported elements still yields its text.
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || '';
  if (log && Array.isArray(result.messages) && result.messages.length) {
    log.warn({ messages: result.messages.slice(0, 20) }, 'extract_docx_messages');
  }
  return { text, meta: {} };
}

module.exports = { extractDocx };
