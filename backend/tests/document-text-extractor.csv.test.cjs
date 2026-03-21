const assert = require('node:assert/strict');
const test = require('node:test');

test('extractTextFromBuffer renders CSV rows with headers into structured text', async () => {
  const { extractTextFromBuffer } = await import('../src/modules/file-upload/document-text-extractor.ts');

  const csv = [
    'S.N.,Frequency,Activity Area,Detailed Tasks',
    '1,Regular,Invoice Create,Generate invoices for completed work',
  ].join('\n');

  const extracted = await extractTextFromBuffer(Buffer.from(csv, 'utf-8'), 'text/csv', 'work-assignment.csv');

  assert.match(extracted, /Structured table extracted from "work-assignment\.csv"\./);
  assert.match(extracted, /Columns \(4\): S\.N\. \| Frequency \| Activity Area \| Detailed Tasks/);
  assert.match(
    extracted,
    /Row 1: S\.N\.: 1 \| Frequency: Regular \| Activity Area: Invoice Create \| Detailed Tasks: Generate invoices for completed work/,
  );
});

test('extractTextFromBuffer keeps quoted commas and multiline CSV cells readable', async () => {
  const { extractTextFromBuffer } = await import('../src/modules/file-upload/document-text-extractor.ts');

  const csv = [
    'Vendor,Notes,Amount',
    '"Acme, Inc.","First line',
    'Second line",1250.00',
  ].join('\n');

  const extracted = await extractTextFromBuffer(Buffer.from(csv, 'utf-8'), 'text/csv', 'vendor.csv');

  assert.match(extracted, /Row 1: Vendor: Acme, Inc\./);
  assert.match(extracted, /Notes: First line \/ Second line/);
  assert.match(extracted, /Amount: 1250\.00/);
});

test('extractTextFromBuffer detects semicolon-delimited CSV exports', async () => {
  const { extractTextFromBuffer } = await import('../src/modules/file-upload/document-text-extractor.ts');

  const csv = [
    'Date;Description;Amount',
    '2026-03-01;Bank fee;125.50',
  ].join('\n');

  const extracted = await extractTextFromBuffer(Buffer.from(csv, 'utf-8'), 'text/csv', 'statement.csv');

  assert.match(extracted, /Columns \(3\): Date \| Description \| Amount/);
  assert.match(extracted, /Row 1: Date: 2026-03-01 \| Description: Bank fee \| Amount: 125\.50/);
});

test('extractTextFromBuffer decodes UTF-16 CSV exports', async () => {
  const { extractTextFromBuffer } = await import('../src/modules/file-upload/document-text-extractor.ts');

  const csv = 'Name,Amount\nAcme,1200.00';
  const buffer = Buffer.from(`\uFEFF${csv}`, 'utf16le');
  const extracted = await extractTextFromBuffer(buffer, 'text/csv', 'utf16.csv');

  assert.match(extracted, /Columns \(2\): Name \| Amount/);
  assert.match(extracted, /Row 1: Name: Acme \| Amount: 1200\.00/);
});

test('resolveSupportedUploadMimeType accepts CSV aliases and extension fallback safely', async () => {
  const {
    resolveSupportedUploadMimeType,
  } = await import('../src/modules/file-upload/file-type-support.ts');

  assert.equal(
    resolveSupportedUploadMimeType({ mimeType: 'text/csv', fileName: 'report.csv' }),
    'text/csv',
  );
  assert.equal(
    resolveSupportedUploadMimeType({ mimeType: 'application/vnd.ms-excel', fileName: 'report.csv' }),
    'text/csv',
  );
  assert.equal(
    resolveSupportedUploadMimeType({ mimeType: 'application/octet-stream', fileName: 'REPORT.CSV' }),
    'text/csv',
  );
  assert.equal(
    resolveSupportedUploadMimeType({ mimeType: 'text/plain', fileName: 'report.csv' }),
    'text/csv',
  );
  assert.equal(
    resolveSupportedUploadMimeType({ mimeType: 'application/vnd.ms-excel', fileName: 'report.xls' }),
    undefined,
  );
});
