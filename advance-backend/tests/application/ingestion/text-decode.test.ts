import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextBuffer } from '../../../src/application/ingestion/text-extraction/text-decode.ts';

describe('decodeTextBuffer', () => {
  it('decodes plain UTF-8 text', () => {
    const buf = Buffer.from('Hello, world!', 'utf-8');
    assert.equal(decodeTextBuffer(buf), 'Hello, world!');
  });

  it('strips UTF-8 BOM (EF BB BF)', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.from('BOM content', 'utf-8');
    const buf = Buffer.concat([bom, content]);
    assert.equal(decodeTextBuffer(buf), 'BOM content');
  });

  it('decodes UTF-16 LE with BOM (FF FE)', () => {
    const text = 'Hi';
    const bom = Buffer.from([0xff, 0xfe]);
    const content = Buffer.from(text, 'utf16le');
    const buf = Buffer.concat([bom, content]);
    assert.equal(decodeTextBuffer(buf), 'Hi');
  });

  it('handles empty buffer', () => {
    const buf = Buffer.alloc(0);
    assert.equal(decodeTextBuffer(buf), '');
  });

  it('handles multi-line UTF-8', () => {
    const text = 'line one\nline two\nline three';
    const buf = Buffer.from(text, 'utf-8');
    assert.equal(decodeTextBuffer(buf), text);
  });

  it('handles UTF-8 with non-ASCII characters', () => {
    const text = 'Héllo wörld — こんにちは';
    const buf = Buffer.from(text, 'utf-8');
    assert.equal(decodeTextBuffer(buf), text);
  });
});
