import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLarkMedia,
  isSupportedLarkMedia,
  unsupportedDocumentNotice,
  withoutTransientBytes,
  MAX_INLINE_IMAGE_BYTES,
} from '../../../src/infrastructure/channels/lark/lark-media-support.ts';
import type { GroupChatAttachmentContext } from '../../../src/domain/conversation/group-context.ts';

describe('classifyLarkMedia', () => {
  it('accepts images', () => {
    assert.equal(classifyLarkMedia({ type: 'image' }), 'supported');
    assert.equal(isSupportedLarkMedia({ type: 'image' }), true);
  });

  it('refuses documents', () => {
    // `file` is every document kind the parser produces — PDF, DOCX, XLSX, CSV.
    // There is no per-extension allowance, deliberately: a format that extracts
    // cleanly still has nowhere to be stored and nothing to retrieve it.
    assert.equal(classifyLarkMedia({ type: 'file' }), 'unsupported_document');
    assert.equal(isSupportedLarkMedia({ type: 'file' }), false);
  });
});

describe('unsupportedDocumentNotice', () => {
  const notice = unsupportedDocumentNotice('Q3-revenue.pdf');

  it('names the file so the reply can refer to it', () => {
    assert.match(notice, /Q3-revenue\.pdf/);
  });

  it('forbids inferring content from the filename', () => {
    // The failure this prevents: a model handed `[File: Q3-revenue.pdf]` and
    // nothing else will describe Q3 revenue rather than admit it cannot read.
    assert.match(notice, /Do not guess or infer/i);
    assert.match(notice, /Do not claim to have read it/i);
  });

  it('offers the routes that actually work today', () => {
    assert.match(notice, /screenshot/i, 'images are readable');
    assert.match(notice, /paste/i, 'text can be pasted');
    assert.match(notice, /desktop app/i, 'the desktop app reads documents locally');
  });

  it('says the capability is coming rather than refusing flatly', () => {
    assert.match(notice, /building it|coming soon/i);
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
