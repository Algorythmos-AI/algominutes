'use strict';

// Ported from apps/web src/lib/documentText.ts -> extractPdfText().
//
// Browser -> Node changes:
//  1. pdfjs-dist v4 is ESM-only. We load the *legacy* build via dynamic
//     import() (works from CommonJS): the legacy build ships the polyfills
//     pdf.js needs to run under Node instead of a browser. We do NOT set a
//     GlobalWorkerOptions.workerSrc: in Node with no worker configured pdf.js
//     falls back to running on the main thread, which is what we want in a
//     single-request Cloud Run container.
//  2. The source's OCR fallback for image-only pages rendered each page to a
//     <canvas> and OCR'd the PNG. There is no headless-canvas in Node without
//     pulling in node-canvas (cairo/pango). Instead we rasterize with poppler's
//     `pdftoppm` (spawned; poppler-utils is installed in the Dockerfile) and
//     feed the PNG to the same tesseract path the image endpoint uses. This
//     preserves the source behaviour (text layer first, OCR only for the first
//     few pages of an image-only PDF) using a real Node/system path.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recognizeText } = require('./image');

// Same guard as the source: only OCR-fall-back for small PDFs, so a 400-page
// scanned document does not turn into 400 tesseract runs inside one request.
const PDF_OCR_FALLBACK_MAX_PAGES = 6;

async function extractPdf(buffer, { log } = {}) {
  if (log) log.info({ bytes: buffer.length }, 'extract_pdf_start');

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    // Headless server render: no eval, no system-font probing surprises.
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;

  const pages = [];
  let ocrPages = 0;
  let tmpPdfPath = null;

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text) {
        pages.push(text);
      } else if (pdf.numPages <= PDF_OCR_FALLBACK_MAX_PAGES) {
        // Image-only page: rasterize with poppler then OCR, mirroring the
        // browser's canvas->tesseract fallback.
        if (!tmpPdfPath) tmpPdfPath = writeTempPdf(buffer);
        const ocrText = await ocrPdfPage(tmpPdfPath, pageNo, { log });
        if (ocrText.trim()) {
          pages.push(ocrText.trim());
          ocrPages += 1;
        }
      }
      // page.cleanup() releases the page's object graph; parity with source.
      page.cleanup();
    }
  } finally {
    // The loading task owns the document: pdf.js 5 removed
    // PDFDocumentProxy.destroy(), and this works on 4 as well.
    await loadingTask.destroy();
    if (tmpPdfPath) {
      // Best-effort temp cleanup — surfaced, never silent.
      try { fs.rmSync(tmpPdfPath, { force: true }); }
      catch (err) { if (log) log.warn({ err, tmpPdfPath }, 'pdf_tmp_cleanup_failed'); }
    }
  }

  if (log) log.info({ numPages: pdf.numPages, ocrPages }, 'extract_pdf_done');
  return {
    text: pages.join('\n\n'),
    meta: { numPages: pdf.numPages, ocrPages },
  };
}

function writeTempPdf(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-pdf-'));
  const p = path.join(dir, 'input.pdf');
  fs.writeFileSync(p, buffer);
  return p;
}

// Rasterize a single page to PNG via poppler's pdftoppm, then OCR it.
// Scale 200 DPI is the rough equivalent of the source's `scale: 2` viewport
// and is a good default for tesseract legibility without ballooning memory.
function ocrPdfPage(pdfPath, pageNo, { log }) {
  return new Promise((resolve, reject) => {
    const outPrefix = `${pdfPath}.p${pageNo}`;
    const args = ['-png', '-r', '200', '-f', String(pageNo), '-l', String(pageNo), '-singlefile', pdfPath, outPrefix];
    const child = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => reject(err)); // e.g. poppler-utils not installed
    child.on('close', async (code) => {
      const pngPath = `${outPrefix}.png`;
      if (code !== 0) {
        return reject(new Error(`pdftoppm exited ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const png = fs.readFileSync(pngPath);
        const text = await recognizeText(png, { log });
        try { fs.rmSync(pngPath, { force: true }); }
        catch (rmErr) { if (log) log.warn({ err: rmErr, pngPath }, 'pdf_png_cleanup_failed'); }
        resolve(text);
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = { extractPdf, PDF_OCR_FALLBACK_MAX_PAGES };
