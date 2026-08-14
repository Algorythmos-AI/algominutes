'use strict';

// Ported from apps/web src/lib/ocr.ts.
//
// cleanOcrLines() is copied verbatim — it is pure string logic with no browser
// dependency. recognizeText() is adapted from the browser tesseract.js worker
// to the Node worker: tesseract.js accepts a Buffer / file path directly in
// Node, so there is no Blob/File to pass.
//
// TODO(extractor): the browser version pre-processed the photo with a canvas
// filter (grayscale(100%) contrast(180%) brightness(110%)) and a 1200px
// resize before OCR — see resizeImageForOcr() in the source. That materially
// improves recognition on faded/shadowed photos but relies on
// createImageBitmap + canvas, which do not exist in Node. The clean Node
// equivalent is `sharp` (libvips: .greyscale().linear(contrast, brightness)
// .resize({ width: 1200 })). It is intentionally NOT added here to keep the
// dependency/image surface minimal for P0; add sharp when OCR quality on real
// photos proves insufficient. We run tesseract on the original bytes for now.

const { createWorker } = require('tesseract.js');

// Drop OCR lines that look like UI chrome / noise rather than real content.
// Conservative: a real content line almost always has >=2 letters AND >=40%
// alphabetic chars. (Copied verbatim from ocr.ts.)
function cleanOcrLines(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length < 3) return false;
      const letters = (l.match(/[A-Za-z]/g) ?? []).length;
      if (letters < 2) return false;
      if (letters / l.length < 0.4) return false;
      // status-bar-style timestamp at the very start of a short line
      if (/^\d{1,2}:\d{2}\b/.test(l) && l.length < 25) return false;
      return true;
    });
}

// OCR a single image buffer. `image` is a Buffer (png/jpeg/etc — tesseract.js
// decodes these internally in Node). Returns the cleaned, joined text.
async function recognizeText(image, { log } = {}) {
  let worker = null;
  try {
    // langPath/cachePath point tesseract's model + wasm cache at /tmp, the only
    // writable dir on Cloud Run. See the Dockerfile note about baking
    // eng.traineddata + the wasm core into the image to avoid re-downloading
    // them on every cold start.
    worker = await createWorker('eng', 1, {
      cachePath: process.env.TESSERACT_CACHE_PATH || '/tmp/tesseract',
      logger: (m) => {
        if (log && m && m.status) log.debug({ status: m.status, progress: m.progress }, 'ocr_progress');
      },
    });
    const { data } = await worker.recognize(image);
    const lines = cleanOcrLines(data.text ?? '');
    return lines.join('\n');
  } finally {
    if (worker) {
      // Not a silent catch: a worker that fails to terminate leaks a
      // subprocess, which we surface so a leak shows up in the logs rather
      // than as mysterious memory growth.
      try { await worker.terminate(); }
      catch (err) { if (log) log.warn({ err }, 'ocr_worker_terminate_failed'); }
    }
  }
}

async function extractImage(buffer, { log } = {}) {
  if (log) log.info({ bytes: buffer.length }, 'extract_image_start');
  const text = await recognizeText(buffer, { log });
  return { text, meta: { engine: 'tesseract', lang: 'eng' } };
}

module.exports = { extractImage, recognizeText, cleanOcrLines };
