import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContainerMedia,
  isSupportedContainerMedia,
  unsupportedDocumentNotice,
  audioMimeType,
} from '../../src/application/runtime/container-media.ts';

describe('classifyContainerMedia', () => {
  it('accepts images', () => {
    assert.equal(classifyContainerMedia({ type: 'image' }), 'supported');
    assert.equal(isSupportedContainerMedia({ type: 'image' }), true);
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
        classifyContainerMedia({ type: 'file', fileName }), 'supported',
        `${fileName} should reach the workspace`,
      );
    }
  });

  it('refuses only what no skill can open', () => {
    // The failure this prevents: staging an .mp4 leaves the agent holding a
    // path it can do nothing with, and it will answer from the filename.
    for (const fileName of ['clip.mp4', 'setup.exe', 'song.mp3', 'disk.iso']) {
      assert.equal(
        classifyContainerMedia({ type: 'file', fileName }), 'unsupported_document',
        `${fileName} should be refused`,
      );
    }
    assert.equal(isSupportedContainerMedia({ type: 'file', fileName: 'clip.mp4' }), false);
  });

  it('accepts an unrecognised extension when the sender reports a generic MIME type', () => {
    // Lark sends application/octet-stream for anything its own table misses,
    // and a browser does the same for an extension it has no mapping for.
    // Under a deny-list that is not a reason to refuse — the agent gets the
    // path and decides for itself.
    assert.equal(
      classifyContainerMedia({ type: 'file', fileName: 'q3.pdf', mimeType: 'application/octet-stream' }),
      'supported',
    );
    assert.equal(
      classifyContainerMedia({ type: 'file', fileName: 'export', mimeType: 'application/octet-stream' }),
      'supported',
    );
  });

  it('refuses on MIME type when the filename gives nothing away', () => {
    assert.equal(
      classifyContainerMedia({ type: 'file', fileName: 'recording', mimeType: 'video/mp4' }),
      'unsupported_document',
    );
    assert.equal(
      classifyContainerMedia({ type: 'file', fileName: 'scan', mimeType: 'application/pdf' }),
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

describe('audioMimeType', () => {
  it('recognises the formats a person actually records in', () => {
    // Recognised audio is routed to transcription instead of being staged, so
    // this list is what decides whether a voice memo is heard or refused.
    assert.equal(audioMimeType('memo.m4a'), 'audio/mp4');
    assert.equal(audioMimeType('call.mp3'), 'audio/mpeg');
    assert.equal(audioMimeType('voice-note.ogg'), 'audio/ogg');
    assert.equal(audioMimeType('CALL.MP3'), 'audio/mpeg');
  });

  it('says nothing about a file that is not audio', () => {
    assert.equal(audioMimeType('q3.pdf'), null);
    assert.equal(audioMimeType(undefined), null);
    // A video is unreadable rather than transcribable — it must fall through to
    // the classifier's refusal, not into the transcription path.
    assert.equal(audioMimeType('clip.mp4'), null);
  });
});
