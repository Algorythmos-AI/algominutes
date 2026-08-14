type ImagePage = {
  dataUrl: string;
  width: number;
  height: number;
  format: 'JPEG' | 'PNG';
};

export async function imagesToPdfBlob(images: Blob[]): Promise<Blob> {
  if (images.length === 0) throw new Error('Choose at least one image.');

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 28;
  const boxWidth = pageWidth - margin * 2;
  const boxHeight = pageHeight - margin * 2;

  for (let i = 0; i < images.length; i += 1) {
    if (i > 0) pdf.addPage();
    const page = await loadImagePage(images[i]);
    const scale = Math.min(boxWidth / page.width, boxHeight / page.height);
    const width = page.width * scale;
    const height = page.height * scale;
    const x = (pageWidth - width) / 2;
    const y = (pageHeight - height) / 2;
    pdf.addImage(page.dataUrl, page.format, x, y, width, height);
  }

  return pdf.output('blob');
}

function loadImagePage(blob: Blob): Promise<ImagePage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const image = new Image();
      image.onerror = () => reject(new Error('Could not load image.'));
      image.onload = () => {
        resolve({
          dataUrl,
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
          format: blob.type.includes('png') ? 'PNG' : 'JPEG',
        });
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(blob);
  });
}
