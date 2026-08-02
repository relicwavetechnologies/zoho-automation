import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WORKBOOK_CONVERSION_RETRY_DELAY_MS,
  type WorkbookConversionJobPayload,
} from '../../src/application/data-export/workbook-conversion.queue.ts';
import { WorkbookConversionConfirmationService } from '../../src/application/data-export/workbook-conversion.service.ts';
import { GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS } from '../../src/application/data-export/google-drive-xlsx-conversion.checkpoint.store.ts';

describe('workbook conversion confirmation', () => {
  it('queues the exact trusted conversation and leaves enough time for a crashed lease to expire', async () => {
    let queued: WorkbookConversionJobPayload | undefined;
    const service = new WorkbookConversionConfirmationService({
      offers: {
        getWorkbookConversionOfferForActor: async () => ({
          version: 1,
          kind: 'workbook_conversion_offer',
          status: 'offered',
          effectKind: 'workbook_conversion_offered',
          offerId: '44444444-4444-4444-8444-444444444444',
          companyId: 'company-1',
          userId: 'user-1',
          chatId: 'oc-1',
          threadId: 'thread-1',
          runId: 'run-1',
          connectionId: '11111111-1111-4111-8111-111111111111',
          fileId: 'file-1',
          fileName: 'Budget.xlsx',
          replyInThread: true,
          createdAt: new Date().toISOString(),
        }),
      },
      queue: {
        enqueue: async payload => {
          queued = payload;
          return 'wbc_offer';
        },
      },
    });

    await service.confirmForActor({
      offerId: '44444444-4444-4444-8444-444444444444',
      companyId: 'company-1',
      userId: 'user-1',
      chatId: 'oc-1',
      sourceMessageId: 'om-card',
    });

    assert.equal(queued?.conversationKey, 'thread-1');
    assert.equal(queued?.sourceMessageId, 'om-card');
    assert.ok(
      WORKBOOK_CONVERSION_RETRY_DELAY_MS > GOOGLE_DRIVE_XLSX_CONVERSION_LEASE_TTL_SECONDS * 1_000,
    );
  });
});
