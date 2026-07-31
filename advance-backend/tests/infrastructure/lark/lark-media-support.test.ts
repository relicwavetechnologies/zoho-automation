import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLarkMedia,
  isSupportedLarkMedia,
  isAwaitingItsQuestion,
  unsupportedDocumentNotice,
  quotedDocumentNotice,
  MAX_INLINE_IMAGE_BYTES,
} from '../../../src/infrastructure/channels/lark/lark-media-support.ts';
import type { GroupChatAttachmentContext } from '../../../src/domain/conversation/group-context.ts';

describe('classifyLarkMedia', () => {
  it('accepts images', () => {
    assert.equal(classifyLarkMedia({ type: 'image' }), 'supported');
    assert.equal(isSupportedLarkMedia({ type: 'image' }), true);
  });

  it('accepts anything a container skill can open', () => {
    // The backend no longer parses these — the container does. An archive is
    // now accepted precisely because the agent can unzip it, which the old
    // extractor-shaped allow-list refused.
    for (const fileName of [
      'q3.pdf', 'notes.docx', 'legacy.doc', 'budget.xlsx', 'old.xls',
      'rows.csv', 'rows.tsv', 'page.html', 'page.htm', 'readme.md',
      'notes.txt', 'data.json', 'bundle.zip', 'deck.pptx', 'script.py',
    ]) {
      assert.equal(
        classifyLarkMedia({ type: 'file', fileName }), 'supported',
        `${fileName} should reach the workspace`,
      );
    }
  });

  it('refuses only what no skill can open', () => {
    // The failure this prevents: staging an .mp4 leaves the agent holding a
    // path it can do nothing with, and it will answer from the filename.
    for (const fileName of ['clip.mp4', 'setup.exe', 'song.mp3', 'disk.iso']) {
      assert.equal(
        classifyLarkMedia({ type: 'file', fileName }), 'unsupported_document',
        `${fileName} should be refused`,
      );
    }
    assert.equal(isSupportedLarkMedia({ type: 'file', fileName: 'clip.mp4' }), false);
  });

  it('accepts an unrecognised extension when Lark reports a generic MIME type', () => {
    // Lark sends application/octet-stream for anything its own table misses.
    // Under a deny-list that is not a reason to refuse — the agent gets the
    // path and decides for itself.
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'q3.pdf', mimeType: 'application/octet-stream' }),
      'supported',
    );
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'export', mimeType: 'application/octet-stream' }),
      'supported',
    );
  });

  it('refuses on MIME type when the filename gives nothing away', () => {
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'recording', mimeType: 'video/mp4' }),
      'unsupported_document',
    );
    assert.equal(
      classifyLarkMedia({ type: 'file', fileName: 'scan', mimeType: 'application/pdf' }),
      'supported',
    );
  });
});

describe('unsupportedDocumentNotice', () => {
  const notice = unsupportedDocumentNotice('standup-recording.mp4');

  it('names the file so the reply can refer to it', () => {
    assert.match(notice, /standup-recording\.mp4/);
  });

  it('forbids inferring content from the filename', () => {
    // The failure this prevents: a model handed `[File: standup-recording.mp4]`
    // and nothing else will summarise the standup rather than admit it cannot
    // open the file.
    assert.match(notice, /Do not guess or infer/i);
    assert.match(notice, /Do not claim to have read it/i);
  });

  it('names the kinds of file that do work', () => {
    assert.match(notice, /spreadsheets/i);
    assert.match(notice, /archives/i);
  });

  it('blames the format rather than the channel', () => {
    // The desktop app reaches the same container, so sending the user there
    // would fail the same way.
    assert.doesNotMatch(notice, /desktop app/i);
    assert.doesNotMatch(notice, /cannot read documents/i);
  });
});

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
