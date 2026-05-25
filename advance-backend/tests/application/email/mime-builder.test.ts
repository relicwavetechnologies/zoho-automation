import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MimeBuilder } from '../../../src/application/email/mime-builder.ts';

describe('MimeBuilder attachments', () => {
  const builder = new MimeBuilder();

  it('keeps text-only messages simple when no attachments are provided', () => {
    const result = builder.build({
      to: [{ email: 'a@example.com' }],
      subject: 'Plain',
      text: 'Hello',
    });

    assert.match(result.raw, /Content-Type: text\/plain; charset=UTF-8/);
    assert.doesNotMatch(result.raw, /multipart\/mixed/);
  });

  it('wraps HTML alternatives in multipart/mixed when attachments exist', () => {
    const result = builder.build({
      to: [{ email: 'a@example.com' }],
      subject: 'Attached',
      text: 'Plain',
      html: '<p>HTML</p>',
      attachments: [{
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('pdf bytes'),
      }],
    });

    assert.match(result.raw, /Content-Type: multipart\/mixed; boundary="divo_mixed_/);
    assert.match(result.raw, /Content-Type: multipart\/alternative; boundary="divo_alt_/);
    assert.match(result.raw, /Content-Disposition: attachment; filename="report\.pdf"/);
    assert.match(result.raw, /Content-Transfer-Encoding: base64/);
    assert.match(result.raw, new RegExp(Buffer.from('pdf bytes').toString('base64')));
  });

  it('adds multiple attachment parts and uses distinct mixed and alternative boundaries', () => {
    const result = builder.build({
      to: [{ email: 'a@example.com' }],
      subject: 'Two',
      text: 'Plain',
      html: '<p>HTML</p>',
      attachments: [
        { fileName: 'a.txt', mimeType: 'text/plain', content: Buffer.from('a') },
        { fileName: 'b.txt', mimeType: 'text/plain', content: Buffer.from('b') },
      ],
    });

    assert.equal((result.raw.match(/Content-Disposition: attachment/g) ?? []).length, 2);
    const mixed = result.raw.match(/boundary="(divo_mixed_[^"]+)"/)?.[1];
    const alt = result.raw.match(/boundary="(divo_alt_[^"]+)"/)?.[1];
    assert.ok(mixed);
    assert.ok(alt);
    assert.notEqual(mixed, alt);
  });

  it('wraps attachment base64 lines at 76 characters', () => {
    const content = Buffer.alloc(120, 1);
    const result = builder.build({
      to: [{ email: 'a@example.com' }],
      subject: 'Wrapped',
      text: 'Plain',
      attachments: [{ fileName: 'blob.bin', mimeType: 'application/octet-stream', content }],
    });
    const base64 = content.toString('base64');
    assert.match(result.raw, new RegExp(`${base64.slice(0, 76)}\\r\\n${base64.slice(76, 152)}`));
  });
});
