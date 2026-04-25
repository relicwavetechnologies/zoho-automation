export const FILE_DOCUMENT_CLASSES = [
  'policy',
  'contract',
  'handbook',
  'sop',
  'finance_doc',
  'generic_text',
  'media_summary',
  'transcript',
] as const;

export type FileDocumentClass = (typeof FILE_DOCUMENT_CLASSES)[number];

const hasKeyword = (haystack: string, entries: string[]): boolean =>
  entries.some(entry => haystack.includes(entry));

export function classifyFileDocument(input: {
  fileName: string;
  mimeType: string;
  text: string;
}): FileDocumentClass {
  if (input.mimeType.startsWith('image/') || input.mimeType.startsWith('video/')) {
    return 'media_summary';
  }

  const normalized = `${input.fileName}\n${input.text.slice(0, 6000)}`.toLowerCase();

  if (hasKeyword(normalized, ['transcript', 'speaker', 'meeting minutes', '[00:', 'timestamp'])) {
    return 'transcript';
  }
  if (hasKeyword(normalized, ['contract', 'agreement', 'msa', 'nda', 'terms and conditions', 'service level'])) {
    return 'contract';
  }
  if (hasKeyword(normalized, ['handbook', 'employee manual', 'employee guide'])) {
    return 'handbook';
  }
  if (hasKeyword(normalized, ['policy', 'policies', 'compliance', 'leave policy', 'refund policy'])) {
    return 'policy';
  }
  if (hasKeyword(normalized, ['sop', 'runbook', 'playbook', 'procedure', 'workflow', 'onboarding guide'])) {
    return 'sop';
  }
  if (hasKeyword(normalized, ['invoice', 'statement', 'reconciliation', 'balance', 'ledger', 'p&l', 'profit and loss', 'bank'])) {
    return 'finance_doc';
  }
  return 'generic_text';
}
