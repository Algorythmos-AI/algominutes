import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The extractor's PDF text layer, through the real pdfjs-dist (legacy build,
// no worker, main thread). It pins what a pdfjs-dist major could change: the
// module path and loading, the document/page/text-content API, and cleanup.
// The PDF is built here, so no fixture file and no network. The OCR fallback
// (poppler + tesseract) isn't exercised: it doesn't touch pdfjs.
const require = createRequire(import.meta.url);
const { extractPdf } = require('../services/extractor/src/extractors/pdf.js');

/** A minimal, valid PDF: one text line per page, Helvetica, a correct xref. */
function pdfWithPages(texts: string[]): Buffer {
  const objects: string[] = [];
  const fontId = 3 + 2 * texts.length;
  const pageIds = texts.map((_, i) => 3 + 2 * i);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`;
  texts.forEach((t, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`;
    objects[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
    + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('extractPdf (pdfjs-dist)', () => {
  it("reads each page's text layer, in order, without OCR", async () => {
    const { text, meta } = await extractPdf(pdfWithPages(['Quarterly planning notes', 'Action: send the deck']));
    expect(text).toBe('Quarterly planning notes\n\nAction: send the deck');
    expect(meta).toEqual({ numPages: 2, ocrPages: 0 });
  });

  it('a document that is not a PDF is rejected, not read as empty', async () => {
    await expect(extractPdf(Buffer.from('not a pdf at all'))).rejects.toThrow();
  });
});
