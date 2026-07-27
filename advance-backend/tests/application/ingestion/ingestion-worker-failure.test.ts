/**
 * What a silently-indexed document does when indexing fails.
 *
 * A job queued from a room where Divo was not addressed carries no
 * `replyToMessageId`, so there is nowhere to post a failure card. Marking the
 * attachment failed is bookkeeping rather than a message, and must happen
 * anyway — otherwise the transcript reads `processing` forever and Divo keeps
 * promising an answer that is never coming.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IngestionWorker } from '../../../src/application/ingestion/ingestion.worker.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { TypedEnv } from '../../../src/config/env.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

type Recorded = {
  attachmentUpdates: Array<Record<string, unknown>>;
  cardsSent: string[];
};

/** Drives `process` directly; BullMQ itself is not under test. */
async function runFailingJob(payload: Record<string, unknown>): Promise<Recorded> {
  const recorded: Recorded = { attachmentUpdates: [], cardsSent: [] };

  const worker = new IngestionWorker({
    redisUrl: 'redis://unused',
    ingestionService: {
      ingestBuffer: async () => { throw new Error('extractor exploded'); },
    } as never,
    larkAdapter: {
      sendToChatId: async (_chatId: string, card: string) => { recorded.cardsSent.push(card); },
    } as never,
    env: {} as TypedEnv,
    logger: noopLogger,
    chatContext: {
      updateMessageAttachments: async (input: { attachments: Array<Record<string, unknown>> }) => {
        recorded.attachmentUpdates.push(...input.attachments);
        return { ok: true as const, value: null };
      },
    } as never,
  });

  const job = {
    id: 'job-1',
    data: { jobType: 'buffer', bufferBase64: Buffer.from('x').toString('base64'), ...payload },
    attemptsMade: 2,
    opts: { attempts: 3 },
  };

  await assert.rejects(
    () => (worker as unknown as { process(j: unknown): Promise<void> }).process(job),
    /extractor exploded/,
    'the job still fails so BullMQ records it',
  );
  return recorded;
}

const base = {
  companyId: 'co-1',
  uploaderUserId: 'u-1',
  uploaderChannel: 'lark',
  fileName: 'notes.pdf',
  mimeType: 'application/pdf',
  chatId: 'oc_1',
  groupContextMessageId: 'om_1',
};

describe('ingestion worker — terminal failure', () => {
  it('marks the attachment failed even with nowhere to announce it', async () => {
    const recorded = await runFailingJob(base);

    assert.equal(recorded.attachmentUpdates.length, 1, 'the transcript is corrected');
    assert.equal(recorded.attachmentUpdates[0]?.['ingestionStatus'], 'failed');
    assert.match(String(recorded.attachmentUpdates[0]?.['error']), /extractor exploded/);
    assert.deepEqual(recorded.cardsSent, [], 'and Divo stays silent');
  });

  it('also posts a card when there is a message to reply to', async () => {
    const recorded = await runFailingJob({ ...base, replyToMessageId: 'om_1' });

    assert.equal(recorded.attachmentUpdates[0]?.['ingestionStatus'], 'failed');
    assert.equal(recorded.cardsSent.length, 1);
    assert.match(recorded.cardsSent[0]!, /Failed to index/);
  });

  it('does not leave the attachment reading "processing"', async () => {
    // The specific regression: gating the status update on replyToMessageId
    // meant a silent job that died left `processing` in the transcript
    // permanently, with only a server log to show for it.
    const recorded = await runFailingJob(base);

    assert.ok(
      !recorded.attachmentUpdates.some(a => a['ingestionStatus'] === 'processing'),
      'no stale processing status survives',
    );
  });
});
