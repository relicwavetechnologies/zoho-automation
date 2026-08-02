/**
 * Direct tests for the two pure functions that decide what a rule sees.
 *
 * `extractBody` produces the text `bodyContains` is tested against, and
 * `hasAttachment` answers the match field of the same name. Both were reachable
 * only through a full sync before, so a defect in either showed up as "the rule
 * did not fire" with nothing to say why — and the body extractor in particular
 * has a preference order that is easy to get subtly wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractBody,
  hasAttachment,
  type GmailMessagePart,
} from '../../src/infrastructure/google/gmail-history.client.ts';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('extractBody', () => {
  it('prefers the plain-text alternative over the HTML one', () => {
    const message: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Your code is 123456') } },
        { mimeType: 'text/html', body: { data: b64('<p>Your code is 123456</p>') } },
      ],
    };
    assert.equal(extractBody(message), 'Your code is 123456');
  });

  it('falls back to stripped HTML when there is no plain part', () => {
    const message: GmailMessagePart = {
      mimeType: 'text/html',
      body: { data: b64('<style>p{color:red}</style><p>Total&nbsp;&amp;due: 500</p>') },
    };
    // Style and script contents must not survive, or `bodyContains` matches CSS
    // that no human ever saw in the message.
    assert.equal(extractBody(message), 'Total &due: 500');
  });

  it('reaches a plain part nested several levels down', () => {
    const message: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64('Invoice attached') } },
              ],
            },
          ],
        },
        { mimeType: 'application/pdf', filename: 'invoice.pdf' },
      ],
    };
    assert.equal(extractBody(message), 'Invoice attached');
  });

  it('skips an empty plain part rather than returning nothing', () => {
    // A `text/plain` placeholder beside the real HTML is common. Taking it
    // literally leaves `bodyContains` matching against an empty string, so the
    // rule silently never fires.
    const message: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('') } },
        { mimeType: 'text/html', body: { data: b64('<p>Real content</p>') } },
      ],
    };
    assert.equal(extractBody(message), 'Real content');
  });

  it('decodes base64url, which is not interchangeable with base64', () => {
    // Gmail returns base64url. Decoding it as standard base64 corrupts any body
    // whose encoding lands on a `-` or `_`.
    const text = 'subject?? >>> ~~~ ??? ünïcode';
    const message: GmailMessagePart = {
      mimeType: 'text/plain',
      body: { data: Buffer.from(text, 'utf8').toString('base64url') },
    };
    assert.equal(extractBody(message), text);
  });

  it('returns empty for a message with no readable text at all', () => {
    assert.equal(extractBody(undefined), '');
    assert.equal(extractBody({ mimeType: 'image/png', filename: 'x.png' }), '');
  });
});

describe('hasAttachment', () => {
  const part = (
    filename: string,
    headers: Array<[string, string]> = [],
  ): GmailMessagePart => ({
    mimeType: 'application/octet-stream',
    filename,
    headers: headers.map(([name, value]) => ({ name, value })),
  });

  it('is true for a plain attached file', () => {
    assert.equal(hasAttachment(part('invoice.pdf')), true);
  });

  it('is false for the signature logo that used to make every mail match', () => {
    assert.equal(
      hasAttachment(part('logo.png', [['Content-Disposition', 'inline; filename="logo.png"']])),
      false,
    );
    // A `Content-ID` is what the HTML points at, so it is inline even without
    // the disposition saying so.
    assert.equal(hasAttachment(part('logo.png', [['Content-ID', '<logo>']])), false);
  });

  it('trusts an explicit attachment disposition over a stray Content-ID', () => {
    // Some clients stamp a Content-ID on every part they emit. Reading that as
    // inline would stop an attachment rule firing on real attachments.
    assert.equal(
      hasAttachment(part('invoice.pdf', [
        ['Content-Disposition', 'attachment; filename="invoice.pdf"'],
        ['Content-ID', '<part1>'],
      ])),
      true,
    );
  });

  it('reads the header name whatever case it arrives in', () => {
    assert.equal(
      hasAttachment(part('logo.png', [['CONTENT-DISPOSITION', 'INLINE']])),
      false,
    );
  });

  it('finds an attachment nested inside a multipart tree', () => {
    assert.equal(
      hasAttachment({
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('see attached') } },
          {
            mimeType: 'multipart/related',
            parts: [part('report.xlsx')],
          },
        ],
      }),
      true,
    );
  });

  it('is false for a message that is only text', () => {
    assert.equal(
      hasAttachment({ mimeType: 'text/plain', body: { data: b64('hello') } }),
      false,
    );
    assert.equal(hasAttachment(undefined), false);
  });

  it('ignores a part whose filename is only whitespace', () => {
    assert.equal(hasAttachment(part('   ')), false);
  });
});
