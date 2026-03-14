const assert = require('node:assert/strict');
const test = require('node:test');

const { larkRecentFilesStore } = require('../dist/company/channels/lark/lark-recent-files.store');

const sampleFile = (id) => ({
  fileAssetId: id,
  cloudinaryUrl: `https://example.com/${id}`,
  mimeType: 'image/png',
  fileName: `${id}.png`,
});

test('larkRecentFilesStore consume returns pending files once and clears them', () => {
  const chatId = `chat:${Date.now()}`;
  larkRecentFilesStore.add(chatId, [sampleFile('file_a'), sampleFile('file_b')]);

  const first = larkRecentFilesStore.consume(chatId);
  const second = larkRecentFilesStore.consume(chatId);

  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});
