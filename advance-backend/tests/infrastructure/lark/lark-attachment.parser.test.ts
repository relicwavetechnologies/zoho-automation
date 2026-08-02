import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLarkAttachments } from '../../../src/infrastructure/channels/lark/lark-attachment.parser.ts';

function makeEvent(messageType: string, content: Record<string, unknown>, messageId = 'om_test_123'): unknown {
  return {
    event: {
      message: {
        message_id:   messageId,
        message_type: messageType,
        content: JSON.stringify(content),
      },
    },
  };
}

describe('parseLarkAttachments', () => {
  it('returns empty for non-attachment message types', () => {
    const event = makeEvent('text', { text: 'hello' });
    assert.deepEqual(parseLarkAttachments(event), []);
  });

  it('parses image message and captures messageId', () => {
    const event = makeEvent('image', { image_key: 'img_v3_abcdef12' }, 'om_msg_abc');
    const result = parseLarkAttachments(event);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, 'image');
    assert.equal(result[0]!.key, 'img_v3_abcdef12');
    assert.equal(result[0]!.mimeType, 'image/jpeg');
    assert.equal(result[0]!.messageId, 'om_msg_abc');
  });

  it('parses file message', () => {
    const event = makeEvent('file', { file_key: 'file_key_123', file_name: 'report.pdf' });
    const result = parseLarkAttachments(event);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, 'file');
    assert.equal(result[0]!.key, 'file_key_123');
    assert.equal(result[0]!.fileName, 'report.pdf');
    assert.equal(result[0]!.mimeType, 'application/pdf');
  });

  it('parses DOCX file correctly by extension', () => {
    const event = makeEvent('file', { file_key: 'fk_doc', file_name: 'contract.docx' });
    const result = parseLarkAttachments(event);
    assert.equal(result[0]!.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('routes uploaded audio files through voice transcription metadata', () => {
    const event = makeEvent('file', { file_key: 'fk_audio', file_name: 'standup.MP3' });
    assert.deepEqual(parseLarkAttachments(event), [{
      type: 'audio',
      source: 'file',
      key: 'fk_audio',
      fileName: 'standup.MP3',
      mimeType: 'audio/mpeg',
      messageId: 'om_test_123',
      durationMs: null,
    }]);
  });

  it('marks native audio as a duration-checked voice note', () => {
    const event = makeEvent('audio', { file_key: 'fk_voice', duration: 4_000 });
    assert.deepEqual(parseLarkAttachments(event), [{
      type: 'audio',
      source: 'voice-note',
      key: 'fk_voice',
      fileName: 'voice-note.ogg',
      mimeType: 'audio/ogg',
      messageId: 'om_test_123',
      durationMs: 4_000,
    }]);
  });

  it('parses images inside post message', () => {
    const event = makeEvent('post', {
      content: [
        [
          { tag: 'text', text: 'Here is the diagram:' },
          { tag: 'img', image_key: 'img_post_001' },
        ],
      ],
    });
    const result = parseLarkAttachments(event);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, 'image');
    assert.equal(result[0]!.key, 'img_post_001');
  });

  it('deduplicates images with same key in post', () => {
    const event = makeEvent('post', {
      content: [
        [
          { tag: 'img', image_key: 'img_dup' },
          { tag: 'img', image_key: 'img_dup' },
        ],
      ],
    });
    const result = parseLarkAttachments(event);
    assert.equal(result.length, 1);
  });

  it('returns empty if no message in event', () => {
    assert.deepEqual(parseLarkAttachments({}), []);
    assert.deepEqual(parseLarkAttachments({ event: {} }), []);
  });

  it('handles malformed content JSON gracefully', () => {
    const event = {
      event: {
        message: {
          message_type: 'image',
          content: 'not-json',
        },
      },
    };
    const result = parseLarkAttachments(event);
    assert.deepEqual(result, []);
  });
});
