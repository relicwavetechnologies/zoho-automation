import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// pdfjs-dist v5 uses dynamic import(workerSrc) in Node.js.
// Point it to the real worker module so the "fake worker" setup succeeds.
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';

export async function extractPdfText(buf: Buffer): Promise<string> {
  const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await (pdfjsLib as any).getDocument({ data: uint8, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const pageTexts: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = (textContent.items as Array<{ str: string }>)
      .map(item => item.str)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (pageText) pageTexts.push(pageText);
  }

  return pageTexts.join('\n\n');
}
