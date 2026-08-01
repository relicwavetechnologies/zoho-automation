import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { DefaultKnowledgeDocumentParser } from '../../src/infrastructure/knowledge/default-knowledge-document.parser.ts';

const parseSignal = (): AbortSignal => AbortSignal.timeout(10_000);

describe('default governed document parser', () => {
  it('extracts real native PDF text with page provenance', async () => {
    const parser = new DefaultKnowledgeDocumentParser({ ocr: null, maxPages: 10, maxOcrPages: 2 });
    const parsed = await parser.parse({
      buffer: createPdf('DOC-TEAM-A91C rollback must appear before owners.'),
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      signal: parseSignal(),
    });
    assert.equal(parsed.pageCount, 1);
    assert.equal(parsed.units[0]?.pageNumber, 1);
    assert.match(parsed.units[0]?.text ?? '', /rollback must appear before owners/i);
  });

  it('extracts DOCX headings, XLSX sheet rows, and PPTX slide text', async () => {
    const parser = new DefaultKnowledgeDocumentParser({ ocr: null, maxPages: 10, maxOcrPages: 2 });
    const docx = await parser.parse({
      buffer: await createDocx(),
      fileName: 'procedure.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      signal: parseSignal(),
    });
    assert.match(docx.units[0]?.text ?? '', /# Rollback/);
    assert.match(docx.units[0]?.text ?? '', /Restore the previous release/);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Marker', 'Rule'],
      ['DOC-TEAM-A91C', 'Friday at 5 PM'],
    ]), 'QA Policy');
    const xlsx = await parser.parse({
      buffer: Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })),
      fileName: 'policy.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      signal: parseSignal(),
    });
    assert.deepEqual(xlsx.units[0]?.sectionPath, ['QA Policy']);
    assert.match(xlsx.units[0]?.text ?? '', /DOC-TEAM-A91C/);

    const pptx = await parser.parse({
      buffer: await createPptx(),
      fileName: 'runbook.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      signal: parseSignal(),
    });
    assert.equal(pptx.pageCount, 2);
    assert.match(pptx.units[1]?.text ?? '', /Owners verify completion/);
  });

  it('uses OCR for a real image and preserves low-confidence warnings', async () => {
    let receivedBytes = 0;
    const parser = new DefaultKnowledgeDocumentParser({
      ocr: {
        extract: async input => {
          receivedBytes = input.image.length;
          return {
            text: 'Scanned QA cutoff is Friday at 5 PM.',
            caption: 'A scanned policy page',
            confidence: 0.55,
            warnings: ['blurred footer'],
          };
        },
      },
      maxPages: 10,
      maxOcrPages: 2,
    });
    const image = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex');
    const parsed = await parser.parse({
      buffer: image,
      fileName: 'scan.png',
      mimeType: 'image/png',
      signal: parseSignal(),
    });
    assert.equal(receivedBytes, image.length);
    assert.match(parsed.units[0]?.text ?? '', /Friday at 5 PM/);
    assert.ok(parsed.warnings.some(warning => /below 0.6/.test(warning)));
  });

  it('fails closed when OCR is required but not configured', async () => {
    const parser = new DefaultKnowledgeDocumentParser({ ocr: null, maxPages: 10, maxOcrPages: 2 });
    await assert.rejects(parser.parse({
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      fileName: 'scan.png',
      mimeType: 'image/png',
      signal: parseSignal(),
    }), /OCR is not configured/);
  });

  it('rejects Office decompression bombs before invoking a heavy format parser', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/slides/slide1.xml', 'A'.repeat(100_000));
    const compressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const parser = new DefaultKnowledgeDocumentParser({
      ocr: null,
      maxPages: 10,
      maxOcrPages: 2,
      maxArchiveEntries: 10,
      maxArchiveUncompressedBytes: 10_000,
      maxArchiveCompressionRatio: 20,
    });
    await assert.rejects(parser.parse({
      buffer: compressed,
      fileName: 'bomb.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      signal: parseSignal(),
    }), /expands beyond|compression ratio/);
  });

  it('honors the shared parse deadline even when an OCR provider does not settle', async () => {
    const controller = new AbortController();
    const parser = new DefaultKnowledgeDocumentParser({
      ocr: { extract: async () => new Promise<never>(() => undefined) },
      maxPages: 10,
      maxOcrPages: 2,
    });
    const pending = parser.parse({
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      fileName: 'scan.png',
      mimeType: 'image/png',
      signal: controller.signal,
    });
    controller.abort(new Error('test parse timeout'));
    await assert.rejects(pending, /test parse timeout/);
  });
});

function createPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/gu, '\\$1');
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

async function createDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Rollback</w:t></w:r></w:p><w:p><w:r><w:t>Restore the previous release.</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function createPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Rollback first</a:t></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Owners verify completion</a:t></p:sld>');
  return zip.generateAsync({ type: 'nodebuffer' });
}
