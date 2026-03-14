const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inferLarkMessageType,
  parseLarkAttachmentKeys,
  parseLarkMessageContent,
} = require('../dist/company/channels/lark/lark-message-content');

test('parseLarkMessageContent returns a conversation placeholder for image messages', () => {
  const result = parseLarkMessageContent(JSON.stringify({ image_key: 'img_123' }), 'image');
  assert.equal(result, '[User attached an image]');
});

test('parseLarkMessageContent includes file name when present for file messages', () => {
  const result = parseLarkMessageContent(
    JSON.stringify({ file_key: 'file_123', file_name: 'spec-sheet.pdf' }),
    'file',
  );
  assert.equal(result, '[User attached a file: spec-sheet.pdf]');
});

test('parseLarkAttachmentKeys extracts file metadata for downstream ingestion', () => {
  const result = parseLarkAttachmentKeys(
    JSON.stringify({ file_key: 'file_123', file_name: 'spec-sheet.pdf', file_type: 'pdf' }),
    'file',
  );

  assert.deepEqual(result, [
    {
      key: 'file_123',
      fileType: 'file',
      fileName: 'spec-sheet.pdf',
      larkFileType: 'pdf',
    },
  ]);
});

test('inferLarkMessageType detects image payloads from content when msg_type is missing', () => {
  const result = inferLarkMessageType({
    content: JSON.stringify({ image_key: 'img_123' }),
  });

  assert.equal(result, 'image');
});

test('inferLarkMessageType prefers alternate message_type when msg_type is missing', () => {
  const result = inferLarkMessageType({
    altMsgType: 'file',
    content: JSON.stringify({ file_key: 'file_123' }),
  });

  assert.equal(result, 'file');
});

test('inferLarkMessageType detects direct rich-post payloads when msg_type is missing', () => {
  const result = inferLarkMessageType({
    content: JSON.stringify({
      title: '',
      content: [
        [{ tag: 'img', image_key: 'img_234' }],
        [{ tag: 'text', text: 'What do you see in this image?' }],
      ],
    }),
  });

  assert.equal(result, 'post');
});

test('parseLarkMessageContent extracts text from direct rich-post payloads', () => {
  const result = parseLarkMessageContent(JSON.stringify({
    title: '',
    content: [
      [{ tag: 'img', image_key: 'img_234' }],
      [{ tag: 'text', text: 'What do you see in this image?' }],
    ],
  }), 'post');

  assert.equal(result, 'What do you see in this image?');
});

test('parseLarkAttachmentKeys extracts embedded images from rich-post payloads', () => {
  const result = parseLarkAttachmentKeys(JSON.stringify({
    title: '',
    content: [
      [{ tag: 'img', image_key: 'img_234' }],
      [{ tag: 'text', text: 'What do you see in this image?' }],
    ],
  }), 'post');

  assert.deepEqual(result, [
    {
      key: 'img_234',
      fileType: 'image',
    },
  ]);
});
