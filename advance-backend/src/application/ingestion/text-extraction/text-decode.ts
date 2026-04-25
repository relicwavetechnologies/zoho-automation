/** BOM-aware UTF-8/UTF-16 decode for plain text and markdown files. */
export function decodeTextBuffer(buf: Buffer): string {
  const b0 = buf[0] ?? 0, b1 = buf[1] ?? 0, b2 = buf[2] ?? 0;
  // UTF-16 LE BOM: FF FE
  if (b0 === 0xff && b1 === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  // UTF-16 BE BOM: FE FF
  if (b0 === 0xfe && b1 === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length - 1; i += 2) {
      swapped[i - 2] = buf[i + 1] ?? 0;
      swapped[i - 1] = buf[i] ?? 0;
    }
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM: EF BB BF
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    return buf.slice(3).toString('utf-8');
  }
  return buf.toString('utf-8');
}
