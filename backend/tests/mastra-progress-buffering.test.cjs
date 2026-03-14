const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSerializedStageUpdater,
  findProgressFlushIndex,
  splitProgressBuffer,
} = require('../dist/company/orchestration/engine/mastra-orchestration.engine');

test('findProgressFlushIndex returns the last sentence boundary including trailing whitespace', () => {
  const text = 'I will check that now. Next sentence still buffered';
  assert.equal(findProgressFlushIndex(text), 'I will check that now. '.length);
});

test('findProgressFlushIndex treats newline as a flush boundary', () => {
  const text = 'First line complete\nSecond line pending';
  assert.equal(findProgressFlushIndex(text), 'First line complete\n'.length);
});

test('splitProgressBuffer returns sentence-safe flush segment when punctuation is present', () => {
  const result = splitProgressBuffer('Looking into Zoho now. Pulling the latest deals');
  assert.deepEqual(result, {
    flushText: 'Looking into Zoho now. ',
    remainder: 'Pulling the latest deals',
  });
});

test('splitProgressBuffer waits when there is no sentence boundary and no fallback trigger', () => {
  const result = splitProgressBuffer('Looking into Zoho now');
  assert.equal(result, null);
});

test('splitProgressBuffer flushes on inactivity timeout even without punctuation', () => {
  const result = splitProgressBuffer('Looking into Zoho now', { intervalElapsed: true });
  assert.deepEqual(result, {
    flushText: 'Looking into Zoho now',
    remainder: '',
  });
});

test('splitProgressBuffer flushes the remainder on force', () => {
  const result = splitProgressBuffer('Partial response in progress', { force: true });
  assert.deepEqual(result, {
    flushText: 'Partial response in progress',
    remainder: '',
  });
});

test('createSerializedStageUpdater runs stage updates one at a time in call order', async () => {
  const callOrder = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  const queue = createSerializedStageUpdater(async (text) => {
    callOrder.push(`start:${text}`);
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeCount -= 1;
    callOrder.push(`end:${text}`);
  });

  await Promise.all([
    queue('processing'),
    queue('retrieving'),
    queue('generating'),
  ]);

  assert.equal(maxActiveCount, 1);
  assert.deepEqual(callOrder, [
    'start:processing',
    'end:processing',
    'start:retrieving',
    'end:retrieving',
    'start:generating',
    'end:generating',
  ]);
});
