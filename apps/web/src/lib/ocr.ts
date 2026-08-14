import { createWorker, type Worker as TWorker } from 'tesseract.js';

export type OcrProgress = { status: string; progress: number };

// Drop OCR lines that look like UI chrome / noise rather than real content.
// Conservative: a real content line almost always has ≥2 letters AND ≥40% alphabetic chars.
export function cleanOcrLines(rawText: string): string[] {
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

// Safely resizes and enhances a large photo before handing it to Tesseract.
// Prevents OutOfMemory crashes and dramatically improves text recognition accuracy.
async function resizeImageForOcr(image: Blob | string): Promise<Blob | string> {
  if (typeof image === 'string') return image;
  if (!image.type.startsWith('image/')) return image;
  try {
    // 1200px is safe for RAM but high enough resolution for clear text
    const bmp = await createImageBitmap(image, { resizeWidth: 1200 });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return image;
    
    // Apply powerful OCR enhancements: Grayscale, high contrast, slight brightness boost
    // This turns faded/shadowy photos into high-contrast documents that Tesseract loves.
    ctx.filter = 'grayscale(100%) contrast(180%) brightness(110%)';
    ctx.drawImage(bmp, 0, 0);
    
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b || image), 'image/jpeg', 0.85);
    });
  } catch (err) {
    console.warn('Image resize/enhance failed, using original', err);
    return image;
  }
}

export async function recognizeText(
  image: Blob | string,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  let worker: TWorker | null = null;
  try {
    if (onProgress) onProgress({ status: 'optimizing image', progress: 0 });
    const optimizedImage = await resizeImageForOcr(image);
    
    worker = await createWorker('eng', 1, {
      logger: (m) => {
        if (onProgress) onProgress({ status: m.status ?? 'working', progress: m.progress ?? 0 });
      },
    });
    const { data } = await worker.recognize(optimizedImage);
    const lines = cleanOcrLines(data.text ?? '');
    return lines.join('\n');
  } finally {
    if (worker) {
      try { await worker.terminate(); } catch (err) { console.warn('ocr_worker_terminate_failed', err); }
    }
  }
}
