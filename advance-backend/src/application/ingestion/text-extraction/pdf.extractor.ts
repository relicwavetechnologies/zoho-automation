import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Disable the web worker — in Node.js the legacy build runs synchronously on the main thread.
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';

export async function extractPdfText(buf: Buffer): Promise<string> {
  const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await (pdfjsLib as any).getDocument({ data: uint8 }).promise;
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
