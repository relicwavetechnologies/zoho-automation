import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INGESTION_QUEUE_NAME,
  resolveIngestionQueueName,
} from '../../../src/application/ingestion/ingestion.queue.ts';

describe('resolveIngestionQueueName', () => {
  it('preserves a configured queue name', () => {
    assert.equal(resolveIngestionQueueName('lark-media-ingestion'), 'lark-media-ingestion');
  });

  it('falls back to the default ingestion queue', () => {
    assert.equal(resolveIngestionQueueName(), INGESTION_QUEUE_NAME);
  });
});
