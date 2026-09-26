'use strict';

// services/extractor — document text extraction (Cloud Run, async).
//
// Replaces the JS-only client pipeline (apps/web src/lib/documentText.ts,
// ocr.ts, imagePdf.ts, and the transcoder's youtube.js). PDF / DOCX / OCR /
// YouTube extraction lived in the browser via pdfjs-dist / mammoth /
// tesseract.js — code that cannot survive into Swift or Kotlin, forcing three
// implementations. This service is the ONE implementation the three clients
// share (BUILD-PLAN A3 / §3.2).
//
// House style matches the transcoder: express server, structured logger with a
// traceId per request, no silent catches, and a handler that works whether the
// request arrives directly (a client / the api service) or as a Cloud Tasks
// push. Extraction is a pure function of its input bytes, so every endpoint is
// naturally idempotent — the same input returns the same output and we write no
// state, so there is no dedupe key to manage (see README "Idempotency").

const express = require('express');

const sharedLogger = require('@algominutes/ai/logger.cjs');
const { requireEnv } = require('@algominutes/ai/require-env.cjs');
requireEnv('extractor', require('./env-spec.cjs'), { logger: sharedLogger.logger });

const storage = require('./storage');
const { readInput } = require('./input');
const { extractPdf } = require('./extractors/pdf');
const { extractDocx } = require('./extractors/docx');
const { extractImage } = require('./extractors/image');
const { extractYoutube } = require('./extractors/youtube');

const app = express();
// Inline uploads arrive base64-encoded in the JSON body; cap generously but
// finite. Larger inputs must go through storagePath (a GCS reference), the
// same split the transcoder uses for audio.
app.use(express.json({ limit: '32mb' }));

const rootLog = sharedLogger.logger.child({ svc: 'extractor' });

app.get('/health', (_req, res) => res.status(200).send('ok'));

// One handler shape for every kind. `run` returns { text, meta }.
function makeRoute(kind, run) {
  return async (req, res) => {
    const traceId = sharedLogger.traceIdFromTask(req.body, req.headers);
    // Carry any caller-supplied correlation ids through the logs, exactly as
    // the transcoder threads noteId/workspaceId. Extraction itself needs none
    // of them, but a request that came from a Cloud Task should stay
    // attributable end to end.
    const log = rootLog.child({
      traceId,
      kind,
      noteId: req.body && req.body.noteId,
      workspaceId: req.body && req.body.workspaceId,
    });
    const deps = { storage, log };

    try {
      const { text, meta } = await run(req.body || {}, deps);
      log.info({ chars: text.length }, 'extract_ok');
      return res.status(200).json({
        ok: true,
        kind,
        text,
        chars: text.length,
        traceId,
        ...(meta ? { meta } : {}),
      });
    } catch (err) {
      const status = Number(err && err.status) || 500;
      if (status >= 400 && status < 500) {
        // Permanent / caller-fixable (bad input, unsupported, restricted
        // video). Retrying will not help, so we return a 4xx with a message
        // safe to show a user. The transcoder makes the same call by not
        // re-throwing permanent YouTube failures.
        log.warn({ err }, 'extract_rejected');
        return res.status(status).json({
          ok: false,
          kind,
          error: (err && (err.publicMessage || err.message)) || 'bad_request',
          code: err && err.code,
          permanent: true,
          traceId,
        });
      }
      // Transient / unexpected: surface a 500 so a Cloud Tasks push retries per
      // the queue's backoff policy. Never a silent catch — the error is logged
      // with its traceId.
      log.error({ err }, 'extract_failed');
      return res.status(500).json({ ok: false, kind, error: 'extraction_failed', traceId });
    }
  };
}

// Versioned from day one (§A3 "Version from day one"). Never break /v1.
app.post('/v1/extract/pdf', makeRoute('pdf', (body, deps) => withBytes(extractPdf, body, deps)));
app.post('/v1/extract/docx', makeRoute('docx', (body, deps) => withBytes(extractDocx, body, deps)));
app.post('/v1/extract/image', makeRoute('image', (body, deps) => withBytes(extractImage, body, deps)));
app.post('/v1/extract/youtube', makeRoute('youtube', (body, deps) => {
  if (!body || typeof body.url !== 'string' || !body.url.length) {
    const err = new Error('provide a youtube "url"');
    err.status = 400;
    throw err;
  }
  return extractYoutube({ url: body.url, log: deps.log });
}));

// The three byte-oriented endpoints share input normalisation (bytesBase64 |
// storagePath -> Buffer); only youtube takes a URL instead.
async function withBytes(fn, body, deps) {
  const buffer = await readInput(body, deps);
  return fn(buffer, deps);
}

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  rootLog.info({ port }, 'extractor_started');
});

module.exports = { app };
