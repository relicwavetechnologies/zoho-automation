import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAwaitingItsQuestion,
  quotedDocumentNotice,
  MAX_INLINE_IMAGE_BYTES,
} from '../../../src/infrastructure/channels/lark/lark-media-support.ts';


describe('quotedDocumentNotice', () => {
  const notice = quotedDocumentNotice('Q3-revenue.pdf');

  it('names the file so the reply can refer to it', () => {
    assert.match(notice, /Q3-revenue\.pdf/);
  });

  it('sends the model to the workspace copy rather than reproducing content', () => {
    // The file was staged when it was posted; the quote-reply is a pointer to
    // it, not an occasion to re-send it.
    assert.match(notice, /workspace/i);
    assert.match(notice, /\.divo\/inbox/);
  });

  it('does not send the model to retrieval tools that no longer exist', () => {
    // The failure this prevents: an instruction to call contextSearch makes
    // the model hunt for a tool it was never given and report the file
    // missing — while the user is looking at it.
    assert.doesNotMatch(notice, /contextSearch|documentRag|fileAssetId/);
  });

  it('gives an honest out when the file is genuinely gone', () => {
    assert.match(notice, /ask for it again/i);
    assert.match(notice, /Never answer from the filename alone/i);
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
