import { KnowledgeMutationError } from './knowledge-mutation.errors';

export const KNOWLEDGE_FILE_INSPECTION_VERSION = 'strict-v1';

const EXTENSIONS_BY_MIME: Readonly<Record<string, readonly string[]>> = {
  'application/json': ['.json'],
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'image/gif': ['.gif'],
  'image/jpeg': ['.jpeg', '.jpg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'text/csv': ['.csv'],
  'text/markdown': ['.markdown', '.md'],
  'text/plain': ['.txt'],
};

const EXECUTABLE_SIGNATURES = [
  Buffer.from([0x4d, 0x5a]), // PE/Windows
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal / Java class
];

/**
 * Fail-closed content verification for bytes entering governed storage.
 *
 * This is format validation, not a replacement for deployment malware
 * scanning. It prevents MIME/extension spoofing and active formats from being
 * accepted by the application while keeping the scanner boundary deterministic.
 */
export function inspectKnowledgeFile(input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}): { readonly inspectionVersion: typeof KNOWLEDGE_FILE_INSPECTION_VERSION } {
  const lowerName = input.fileName.toLocaleLowerCase();
  const allowedExtensions = EXTENSIONS_BY_MIME[input.mimeType];
  if (!allowedExtensions?.some(extension => lowerName.endsWith(extension))) {
    throw invalid('The file extension does not match its declared file type.');
  }
  if (EXECUTABLE_SIGNATURES.some(signature => input.buffer.subarray(0, signature.length).equals(signature))) {
    throw invalid('Executable files cannot be stored as governed knowledge.');
  }

  switch (input.mimeType) {
    case 'application/pdf':
      requirePrefix(input.buffer, Buffer.from('%PDF-'), 'The file is not a valid PDF.');
      rejectPdfActiveContent(input.buffer);
      break;
    case 'application/json':
      assertText(input.buffer);
      try {
        JSON.parse(decodeText(input.buffer));
      } catch {
        throw invalid('The file is not valid JSON.');
      }
      break;
    case 'text/csv':
    case 'text/markdown':
    case 'text/plain':
      assertText(input.buffer);
      break;
    case 'image/png':
      requirePrefix(input.buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'The file is not a valid PNG image.');
      break;
    case 'image/jpeg':
      requirePrefix(input.buffer, Buffer.from([0xff, 0xd8, 0xff]), 'The file is not a valid JPEG image.');
      if (input.buffer.length < 4 || !input.buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) {
        throw invalid('The JPEG image is incomplete.');
      }
      break;
    case 'image/gif': {
      const header = input.buffer.subarray(0, 6).toString('ascii');
      if (header !== 'GIF87a' && header !== 'GIF89a') throw invalid('The file is not a valid GIF image.');
      break;
    }
    case 'image/webp':
      if (
        input.buffer.length < 12
        || input.buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
        || input.buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
      ) throw invalid('The file is not a valid WebP image.');
      break;
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      assertOpenXml(input.buffer, 'word/');
      break;
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      assertOpenXml(input.buffer, 'xl/');
      break;
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      assertOpenXml(input.buffer, 'ppt/');
      break;
    default:
      throw invalid('This file type has no governed-file validator.');
  }

  return { inspectionVersion: KNOWLEDGE_FILE_INSPECTION_VERSION };
}

function assertText(buffer: Buffer): void {
  if (buffer.includes(0)) throw invalid('Text knowledge files cannot contain binary null bytes.');
  const text = decodeText(buffer);
  if (text.startsWith('#!')) throw invalid('Executable scripts cannot be stored as governed text knowledge.');
}

function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw invalid('Text knowledge files must use valid UTF-8.');
  }
}

function assertOpenXml(buffer: Buffer, familyDirectory: string): void {
  const zipPrefix = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  requirePrefix(buffer, zipPrefix, 'The Office document is not a valid Open XML package.');
  if (
    !buffer.includes(Buffer.from('[Content_Types].xml'))
    || !buffer.includes(Buffer.from(familyDirectory))
  ) {
    throw invalid('The Office document content does not match its declared type.');
  }
}

function rejectPdfActiveContent(buffer: Buffer): void {
  const sample = buffer.toString('latin1').toLocaleLowerCase();
  const forbidden = ['/javascript', '/js ', '/launch', '/embeddedfile', '/openaction'];
  if (forbidden.some(token => sample.includes(token))) {
    throw invalid('PDFs with active or embedded content cannot be stored as governed knowledge.');
  }
}

function requirePrefix(buffer: Buffer, prefix: Buffer, message: string): void {
  if (buffer.length < prefix.length || !buffer.subarray(0, prefix.length).equals(prefix)) {
    throw invalid(message);
  }
}

function invalid(message: string): KnowledgeMutationError {
  return new KnowledgeMutationError('invalid_request', message);
}
