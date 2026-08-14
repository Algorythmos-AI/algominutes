import { recognizeText, type OcrProgress } from './ocr';

export type DocumentExtractionProgress = {
  status: string;
  progress: number;
};

const PDF_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
const PDF_OCR_FALLBACK_MAX_PAGES = 6;

export async function extractTextFromFile(
  file: File,
  onProgress?: (progress: DocumentExtractionProgress) => void,
): Promise<string> {
  const ext = filenameExt(file.name);
  const mime = file.type.toLowerCase();

  if (mime.startsWith('image/')) {
    return recognizeText(file, (p: OcrProgress) => {
      onProgress?.({ status: p.status, progress: p.progress });
    });
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    return extractPdfText(file, onProgress);
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return extractDocxText(file, onProgress);
  }

  if (mime.startsWith('text/') || ['txt', 'md', 'csv'].includes(ext)) {
    onProgress?.({ status: 'reading text', progress: 0.4 });
    return file.text();
  }

  if (ext === 'doc') {
    throw new Error('Legacy .doc files are not supported yet. Please export the document as .docx or PDF.');
  }

  throw new Error('Unsupported file type. Choose an image, PDF, DOCX, TXT, MD, or CSV file.');
}

async function extractPdfText(
  file: File,
  onProgress?: (progress: DocumentExtractionProgress) => void,
): Promise<string> {
  onProgress?.({ status: 'opening PDF', progress: 0.05 });
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        pages.push(text);
      } else if (pdf.numPages <= PDF_OCR_FALLBACK_MAX_PAGES) {
        onProgress?.({
          status: `OCR page ${pageNo}/${pdf.numPages}`,
          progress: Math.min(0.98, (pageNo - 0.5) / Math.max(1, pdf.numPages)),
        });
        const imageBlob = await renderPdfPageToBlob(page);
        const ocrText = await recognizeText(imageBlob);
        if (ocrText.trim()) pages.push(ocrText.trim());
      }
      page.cleanup();
      onProgress?.({
        status: `reading page ${pageNo}/${pdf.numPages}`,
        progress: Math.min(0.98, pageNo / Math.max(1, pdf.numPages)),
      });
    }
  } finally {
    await pdf.destroy();
  }

  return pages.join('\n\n');
}

async function renderPdfPageToBlob(page: any): Promise<Blob> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not render PDF page.');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new Error('Could not render PDF page image.'));
    }, 'image/png');
  });
}

async function extractDocxText(
  file: File,
  onProgress?: (progress: DocumentExtractionProgress) => void,
): Promise<string> {
  onProgress?.({ status: 'opening Word document', progress: 0.15 });
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  onProgress?.({ status: 'document text ready', progress: 1 });
  return result.value || '';
}

function filenameExt(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
