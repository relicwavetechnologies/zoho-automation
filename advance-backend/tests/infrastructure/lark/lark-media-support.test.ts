import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLarkMedia,
  isSupportedLarkMedia,
  isAwaitingItsQuestion,
  unsupportedDocumentNotice,
  quotedDocumentNotice,
  withoutTransientBytes,
  MAX_INLINE_IMAGE_BYTES,
} from '../../../src/infrastructure/channels/lark/lark-media-support.ts';
import type { GroupChatAttachmentContext } from '../../../src/domain/conversation/group-context.ts';

describe('classifyLarkMedia', () => {
  it('accepts images', () => {
    assert.equal(classifyLarkMedia({ type: 'image' }), 'supported');
    assert.equal(isSupportedLarkMedia({ type: 'image' }), true);
  });

  it('accepts every document format that has an extractor behind it', () => {
    // Kept in step with the dispatch in `text-extraction/extract`. A format
    // listed here but missing there would be downloaded, decoded as raw text,
    // and indexed as mojibake.
    for (const fileName of [
      'q3.pdf', 'notes.docx', 'legacy.doc', 'budget.xlsx', 'old.xls',
      'rows.csv', 'rows.tsv', 'page.html', 'page.htm', 'readme.md',
      'notes.txt', 'data.json',
    ]) {
      assert.equal(
        classifyLarkMedia({ type: 'file', fileName }), 'supported',
        `${fileName} should be readable`,
      );
    }
  });

  it('refuses formats with no extractor rather than decoding them as text', () => {
    // The failure this prevents: `extractFromBuffer` falls through to
    // `decodeTextBuffer` for anything it does not recognise, so an archive
    // becomes pages of noise and is embedded as if it were prose.
    for (const fileName of ['bundle.zip', 'clip.mp4', 'setup.exe', 'song.mp3']) {
      assert.equal(
        classifyLarkMedia({ type: 'file', fileName }), 'unsupported_document',
        `${fileName} should be refused`,
      );
    }
    assert.equal(isSupportedLarkMedia({ type: 'file', fileName: 'bundle.zip' }), false);
  });

  it('trusts a readable extension when Lark reports a generic MIME type', () => {
    // Lark sends application/octet-stream for anything the parser's own table
    // misses; refusing a readable PDF over a missing content type would be a
    // silent regression that only shows up for some senders.
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'q3.pdf', mimeType: 'application/octet-stream' }),
      'supported',
    );
  });

  it('trusts a readable MIME type when the filename has no extension', () => {
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'scan', mimeType: 'application/pdf' }),
      'supported',
    );
  });
});

describe('unsupportedDocumentNotice', () => {
  const notice = unsupportedDocumentNotice('archive.zip');

  it('names the file so the reply can refer to it', () => {
    assert.match(notice, /archive\.zip/);
  });

  it('forbids inferring content from the filename', () => {
    // The failure this prevents: a model handed `[File: Q3-revenue.zip]` and
    // nothing else will describe Q3 revenue rather than admit it cannot read.
    assert.match(notice, /Do not guess or infer/i);
    assert.match(notice, /Do not claim to have read it/i);
  });

  it('names the formats that do work', () => {
    assert.match(notice, /PDF/i);
    assert.match(notice, /Excel/i);
  });

  it('blames the format rather than the channel', () => {
    // Divo reads PDFs over Lark now, so the old advice — screenshot it, or use
    // the desktop app — would send the user down a route that fails the same
    // way. The desktop app cannot open a .zip either.
    assert.doesNotMatch(notice, /desktop app/i);
    assert.doesNotMatch(notice, /cannot read documents/i);
  });
});

describe('quotedDocumentNotice — indexing off (the shipped default)', () => {
  const notice = quotedDocumentNotice('Q3-revenue.pdf');

  it('names the file so the reply can refer to it', () => {
    assert.match(notice, /Q3-revenue\.pdf/);
  });

  it('sends the model to the excerpt it already has', () => {
    assert.match(notice, /excerpt/i);
    assert.match(notice, /Answer from that excerpt/i);
  });

  it('forbids searching for chunks that were never written', () => {
    // The failure this prevents: with nothing indexed, a contextSearch for
    // this file returns empty and the model reports it cannot find a document
    // the user is looking at.
    assert.match(notice, /not indexed/i);
    assert.match(notice, /do not call contextSearch or documentRag/i);
  });

  it('asks Divo to say what it could not see rather than guess', () => {
    assert.match(notice, /which part you could not see/i);
    assert.match(notice, /Never answer from the filename alone/i);
  });
});

describe('quotedDocumentNotice — indexing on', () => {
  const notice = quotedDocumentNotice('Q3-revenue.pdf', true);

  it('points at the transcript annotation', () => {
    assert.match(notice, /fileAssetId/);
    assert.match(notice, /contextSearch/);
  });

  it('gives a DM a way through, since a DM has no transcript to look in', () => {
    // The transcript that carries fileAssetId is written only for groups.
    assert.match(notice, /Otherwise call contextSearch/i);
    assert.match(notice, /Q3-revenue\.pdf" as the query/);
  });

  it('does not tell the model to give up before it has searched', () => {
    assert.match(notice, /Only after a search comes back empty/i);
    assert.match(notice, /Never answer from the filename alone/i);
  });
});

describe('withoutTransientBytes', () => {
  const base: GroupChatAttachmentContext = {
    kind: 'image',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    inlineContext: '[Image: "screenshot.png"\nOCR text: total 42]',
  };

  it('drops the inline image bytes', () => {
    const stripped = withoutTransientBytes({
      ...base,
      base64DataUrl: 'data:image/png;base64,AAAA',
    });

    // The group snapshot is a JSON column. Persisting the data URL would put
    // the whole image back in the database by a slower route than the CDN
    // upload this slice removed.
    assert.equal('base64DataUrl' in stripped, false);
  });

  it('keeps the OCR text, which is what a later turn actually reads back', () => {
    const stripped = withoutTransientBytes({
      ...base,
      base64DataUrl: 'data:image/png;base64,AAAA',
    });

    assert.equal(stripped.inlineContext, base.inlineContext);
    assert.equal(stripped.fileName, 'screenshot.png');
  });

  it('returns the same object when there is nothing to strip', () => {
    assert.equal(withoutTransientBytes(base), base);
  });
});

describe('MAX_INLINE_IMAGE_BYTES', () => {
  it('is large enough for an ordinary screenshot', () => {
    // The previous 1 MB cap existed as a fallback behind a CDN upload. With the
    // upload gone it became the only path, and a retina screenshot exceeds it.
    assert.ok(MAX_INLINE_IMAGE_BYTES >= 4 * 1_024 * 1_024);
  });
});

describe('isAwaitingItsQuestion', () => {
  it('waits when a DM carries an attachment and no words', () => {
    // The picture-then-question pattern. Answering the picture alone produces
    // the one reply guaranteed to be useless: shown something, asked nothing.
    assert.equal(
      isAwaitingItsQuestion({ chatType: 'p2p', text: '', supportedAttachmentCount: 1, unsupportedAttachmentCount: 0 }),
      true,
    );
  });

  it('treats whitespace as no words', () => {
    assert.equal(
      isAwaitingItsQuestion({ chatType: 'p2p', text: '   \n ', supportedAttachmentCount: 1, unsupportedAttachmentCount: 0 }),
      true,
    );
  });

  it('answers as soon as the message says something', () => {
    assert.equal(
      isAwaitingItsQuestion({ chatType: 'p2p', text: 'check this img', supportedAttachmentCount: 1, unsupportedAttachmentCount: 0 }),
      false,
    );
  });

  it('never waits on a plain message with nothing attached', () => {
    assert.equal(
      isAwaitingItsQuestion({ chatType: 'p2p', text: '', supportedAttachmentCount: 0, unsupportedAttachmentCount: 0 }),
      false,
    );
  });

  it('refuses an unreadable format now rather than waiting for a question', () => {
    // No follow-up can make a .zip readable, so waiting would leave the user
    // with silence instead of an honest refusal.
    assert.equal(
      isAwaitingItsQuestion({
        chatType: 'p2p', text: '', supportedAttachmentCount: 0, unsupportedAttachmentCount: 1,
      }),
      false,
    );
  });

  it('does not wait when a readable file arrives alongside an unreadable one', () => {
    assert.equal(
      isAwaitingItsQuestion({
        chatType: 'p2p', text: '', supportedAttachmentCount: 1, unsupportedAttachmentCount: 1,
      }),
      false,
    );
  });

  it('does not apply in a group', () => {
    // A group only reaches this path when Divo was addressed, and being
    // addressed with an image is a deliberate request, not a half-finished one.
    assert.equal(
      isAwaitingItsQuestion({ chatType: 'group', text: '', supportedAttachmentCount: 1, unsupportedAttachmentCount: 0 }),
      false,
    );
  });
});


// ─── Inline readers must exist for everything declared supported ────────────

describe('every accepted document format has an inline reader', () => {
  it('extracts a spreadsheet inline rather than handing over a bare filename', async () => {
    // The failure this prevents: `budget.xlsx` was accepted by the classifier
    // but had no branch in `extractDocContext`, so it reached the model as
    // `[File: "budget.xlsx"]` — no content, and no "do not guess" guard either,
    // because the refusal notice no longer applied. The model answers anyway.
    const { extractAttachmentInlineContext } = await import(
      '../../../src/infrastructure/channels/lark/lark-inline-context.ts'
    );
    const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };

    const result = await extractAttachmentInlineContext(
      {
        type: 'file', key: 'k', fileName: 'budget.xlsx', messageId: 'm',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      Buffer.from('not a real workbook'),
      {} as never,
      log,
    );

    // The bytes are deliberate rubbish, so extraction yields nothing — what
    // matters is that it went down a reader branch and said so, rather than
    // falling through to a bare filename the model would speculate from.
    assert.doesNotMatch(
      result.context, /^\[File: "budget\.xlsx"\]$/,
      'a spreadsheet must not fall through to the filename-only branch',
    );
  });
});
