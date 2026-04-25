import mammoth from 'mammoth';

export async function extractDocxText(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value.replace(/\r\n/g, '\n').trim();
}
