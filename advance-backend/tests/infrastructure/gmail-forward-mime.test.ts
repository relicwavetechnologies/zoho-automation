/**
 * A forward must arrive as the message that was sent, not as Divo's rendering
 * of it.
 *
 * The forward carries the original's own content headers and body straight
 * under a new envelope, so HTML, inline images, attachments and transfer
 * encodings survive untouched and the message renders as itself. These tests
 * hold the original's bytes to being present **verbatim**, because any
 * re-encoding at all is what breaks an HTML mail.
 *
 * They also hold the *structure*, which is the defect verbatim bytes did not
 * catch: the original used to be nested inside a `multipart/mixed` of Divo's
 * own, behind a `text/plain` part introducing it. Every byte survived and the
 * mail still arrived looking wrong, because a client shows the first plain
 * part of a `multipart/mixed` as the body — so Divo's introduction became the
 * mail and the real content was pushed underneath it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GmailHistoryClient } from '../../src/infrastructure/google/gmail-history.client.ts';

/** Captures the draft Gmail is asked to create, and hands back a raw source. */
function forwardingGmail(sourceRaw: Buffer) {
  let drafted: Buffer | undefined;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    if (url.includes('format=raw')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ raw: sourceRaw.toString('base64url') }),
      };
    }
    if (url.endsWith('/drafts')) {
      const body = JSON.parse(String(init?.body));
      drafted = Buffer.from(body.message.raw, 'base64url');
      return { ok: true, status: 200, json: async () => ({ id: 'draft-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { client: new GmailHistoryClient(fetchStub), drafted: () => drafted };
}

const source = {
  from: 'Acme Billing <billing@acme.com>',
  to: 'me@company.com',
  subject: 'Your invoice',
  snippet: '',
  bodyText: 'invoice',
  hasAttachment: true,
};

const forward = async (sourceRaw: Buffer): Promise<Buffer> => {
  const gmail = forwardingGmail(sourceRaw);
  await gmail.client.createForwardDraft({
    accessToken: 'token',
    destination: 'archive@company.com',
    mailboxEmail: 'me@company.com',
    sourceMessageId: 'message-1',
    source,
    idempotencyKey: 'mail:abc123',
    ruleId: 'rule-1',
  });
  const drafted = gmail.drafted();
  assert.ok(drafted, 'no draft was created');
  return drafted;
};

describe('forwarding preserves the original message', () => {
  it('passes a multipart HTML body through byte for byte', async () => {
    const body = [
      '--inner',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Plain fallback',
      '--inner',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html><body><table><tr><td style=3D"color:#333">Total =E2=82=B9500</td>'
        + '</tr></table><img src=3D"cid:logo"></body></html>',
      '--inner',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo>',
      '',
      'iVBORw0KGgoAAAANSUhEUg==',
      '--inner--',
      '',
    ].join('\r\n');
    const raw = Buffer.from([
      'From: Acme Billing <billing@acme.com>',
      'To: me@company.com',
      'Subject: Your invoice',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      body,
    ].join('\r\n'), 'utf8');

    const drafted = await forward(raw);

    // The whole original body, unaltered and uninterrupted. A rebuilt forward
    // would fail this even if it rendered identically in one client.
    assert.ok(
      drafted.includes(Buffer.from(body, 'utf8')),
      'the original body was not carried through verbatim',
    );
    // And its own content headers came with it, or the nested part is bytes
    // nothing knows how to read.
    assert.match(
      drafted.toString('utf8'),
      /Content-Type: multipart\/alternative; boundary="inner"/,
    );
  });

  it('keeps the transfer encoding that makes the body decodable', async () => {
    const raw = Buffer.from([
      'Subject: Statement',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'Content-Language: en-GB',
      '',
      'PGh0bWw+PGJvZHk+SGVsbG88L2JvZHk+PC9odG1sPg==',
    ].join('\r\n'), 'utf8');

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /Content-Transfer-Encoding: base64/);
    assert.match(drafted, /Content-Language: en-GB/);
    assert.match(drafted, /PGh0bWw\+PGJvZHk\+SGVsbG88L2JvZHk\+PC9odG1sPg==/);
  });

  it('does not re-encode a content header carrying a non-ASCII byte', async () => {
    // Read as latin1 and written back as UTF-8, every byte above 0x7F becomes
    // two — which corrupts a boundary parameter or a filename and takes the
    // whole part down with it. The bytes have to survive untouched.
    const headerBytes = Buffer.concat([
      Buffer.from('Subject: Statement\r\nContent-Type: text/plain; name="caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from('.txt"\r\n\r\nbody', 'utf8'),
    ]);

    const drafted = await forward(headerBytes);

    assert.ok(
      drafted.includes(Buffer.from('name="caf\xe9.txt"', 'latin1')),
      'a non-ASCII content-header byte was re-encoded',
    );
  });

  it('reads a message that separates its headers with bare newlines', async () => {
    // Not every raw message uses CRLF, and picking the wrong separator puts
    // part of the body into the header block or vice versa.
    const raw = Buffer.from(
      'Subject: Statement\nContent-Type: text/html\n\n<html>hi</html>',
      'utf8',
    );

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /Content-Type: text\/html/);
    assert.match(drafted, /<html>hi<\/html>/);
  });

  it('gives the forward a content type when the original had none', async () => {
    // A part with no `Content-Type` is `text/plain` by RFC, but stating it is
    // what keeps a receiving client from guessing.
    const raw = Buffer.from('Subject: Statement\r\n\r\nplain words', 'utf8');

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(drafted, /plain words/);
  });

  it('refuses raw MIME with no header break rather than guessing one', async () => {
    await assert.rejects(
      forward(Buffer.from('this is not a message', 'utf8')),
      /invalid raw MIME/,
    );
  });

  it('marks its own forward so the rule cannot re-match it', async () => {
    const drafted = (await forward(
      Buffer.from('Subject: Statement\r\n\r\nbody', 'utf8'),
    )).toString('utf8');

    assert.match(drafted, /X-Divo-Mailops: rule-1/);
    // From the original's own header, not Divo's parsed copy of it.
    assert.match(drafted, /^Subject: Fwd: Statement$/m);
  });

  it('keeps the original as the top-level message rather than a part of one', async () => {
    // The whole defect. Wrapping an HTML mail in a `multipart/mixed` behind a
    // plain-text introduction preserved every byte and still rendered wrong:
    // a client shows the first plain part as the body, so the introduction
    // became the mail and the real content was pushed below it.
    const raw = Buffer.from([
      'From: Acme Billing <billing@acme.com>',
      'Subject: Your invoice',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<html><body>Total 500</body></html>',
      '--inner--',
      '',
    ].join('\r\n'), 'utf8');

    const drafted = (await forward(raw)).toString('latin1');

    // The forward's own Content-Type is the original's, so the message is the
    // original rather than a container holding it.
    assert.match(
      drafted,
      /^Content-Type: multipart\/alternative; boundary="inner"$/m,
    );
    assert.doesNotMatch(drafted, /multipart\/mixed/);
    assert.doesNotMatch(drafted, /Forwarded by Divo/);
  });

  it('shows the real sender in the name and routes replies back to them', async () => {
    // The address has to stay the authenticated mailbox or the message fails
    // DMARC, so the display name is the only place the sender can appear —
    // and without Reply-To a reply would go to the relaying mailbox instead of
    // to whoever actually wrote the mail.
    const raw = Buffer.from(
      'From: Acme Billing <billing@acme.com>\r\nSubject: Your invoice\r\n\r\nbody',
      'utf8',
    );

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /^From: Acme Billing via Divo <me@company\.com>$/m);
    assert.match(drafted, /^Reply-To: Acme Billing <billing@acme\.com>$/m);
  });

  it('quotes a bare sender address used as a display name', async () => {
    // An unquoted `@` is not legal in a display name, and an illegal From is
    // rejected outright rather than rendered oddly.
    const raw = Buffer.from(
      'From: billing@acme.com\r\nSubject: Your invoice\r\n\r\nbody',
      'utf8',
    );

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /^From: "billing@acme\.com via Divo" <me@company\.com>$/m);
  });

  it('passes an encoded subject back as the bytes it arrived as', async () => {
    // Decoding and re-encoding an `=?UTF-8?B?...?=` subject is how an accented
    // subject line turns into mojibake. `Fwd:` goes in front of the encoded
    // word, which is legal and leaves it intact.
    const raw = Buffer.from([
      'Subject: =?UTF-8?B?w4ViZXJzaWNodA==?=',
      'Content-Type: text/plain',
      '',
      'body',
    ].join('\r\n'), 'utf8');

    const drafted = (await forward(raw)).toString('utf8');

    assert.match(drafted, /^Subject: Fwd: =\?UTF-8\?B\?w4ViZXJzaWNodA==\?=$/m);
  });
});
