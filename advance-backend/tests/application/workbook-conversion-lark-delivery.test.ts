import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WorkbookConversionLarkDelivery,
  type WorkbookConversionLarkDeliveryJob,
  type WorkbookConversionLarkDeliveryState,
  type WorkbookConversionLarkDeliveryStore,
} from '../../src/application/data-export/workbook-conversion-lark-delivery.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';

const job: WorkbookConversionLarkDeliveryJob = {
  jobKey: 'wbc_offer_1',
  chatId: 'oc_chat_1',
  sourceMessageId: 'om_confirmation_1',
  replyInThread: true,
};

describe('workbook conversion Lark delivery', () => {
  it('sends one separate threaded progress card and updates it on completion', async () => {
    const fixture = createFixture();
    await fixture.delivery.register(job);
    await fixture.delivery.progress({ jobKey: job.jobKey, content: 'Copying the workbook now.' });
    await fixture.delivery.completed({
      jobKey: job.jobKey,
      completion: {
        jobKey: job.jobKey,
        sourceFileId: 'file-1',
        spreadsheetId: 'sheet-1',
        artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
        ownerEmail: 'person@example.com',
        verified: true,
      },
    });

    assert.deepEqual(fixture.sent.map(({ content, ...sent }) => sent), [{
      chatId: 'oc_chat_1',
      replyToMessageId: 'om_confirmation_1',
      idempotencyKey: 'wbc-progress_wbc_offer_1',
      replyInThread: true,
    }]);
    assert.equal(fixture.updated.length, 2);
    assert.match(fixture.updated[0]!.content, /Copying the workbook now/i);
    assert.match(fixture.updated[1]!.content, /Google Sheet copy ready/i);
    assert.match(fixture.updated[1]!.content, /Open Google Sheet/i);
  });

  it('reuses the stored progress message after retry and never sends a second card', async () => {
    const fixture = createFixture();
    await fixture.delivery.register(job);
    await fixture.delivery.progress({ jobKey: job.jobKey, content: 'Starting.' });
    await fixture.delivery.progress({ jobKey: job.jobKey, content: 'Still working.' });

    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.updated.length, 2);
    assert.match(fixture.updated[1]!.content, /Still working/i);
  });

  it('updates the separate progress card with fixed safe failure copy', async () => {
    const fixture = createFixture();
    await fixture.delivery.register(job);
    await fixture.delivery.failed({
      jobKey: job.jobKey,
      content: 'raw provider token and stack trace must never reach Lark',
    });

    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.updated.length, 1);
    assert.match(fixture.updated[0]!.content, /could not convert this Excel workbook/i);
    assert.equal(fixture.updated[0]!.content.includes('raw provider token'), false);
  });
});

function createFixture() {
  const states = new Map<string, WorkbookConversionLarkDeliveryState>();
  const sending = new Set<string>();
  const sent: Array<{
    chatId: string;
    replyToMessageId?: string;
    idempotencyKey?: string;
    replyInThread?: boolean;
    content: string;
  }> = [];
  const updated: Array<{ messageId: string; content: string }> = [];
  const store: WorkbookConversionLarkDeliveryStore = {
    register: async value => {
      const current = states.get(value.jobKey);
      if (current && JSON.stringify(current.job) !== JSON.stringify(value)) {
        throw new Error('Workbook conversion delivery is already bound to a different job.');
      }
      states.set(value.jobKey, current ?? { job: value });
    },
    reserveProgressMessage: async jobKey => {
      const state = states.get(jobKey);
      if (!state) throw new Error('Workbook conversion delivery was not registered.');
      if (state.progressMessageId) return { status: 'ready' as const, state };
      if (sending.has(jobKey)) return { status: 'sending' as const };
      sending.add(jobKey);
      return { status: 'claimed' as const, job: state.job };
    },
    completeProgressMessage: async input => {
      const state = states.get(input.jobKey);
      if (!state) throw new Error('Workbook conversion delivery was not registered.');
      sending.delete(input.jobKey);
      const completed = { ...state, progressMessageId: state.progressMessageId ?? input.progressMessageId };
      states.set(input.jobKey, completed);
      return completed;
    },
  };
  const delivery = new WorkbookConversionLarkDelivery({
    store,
    lark: {
      sendToChatId: async (chatId, content, replyToMessageId, idempotencyKey, replyInThread) => {
        sent.push({ chatId, content, replyToMessageId, idempotencyKey, replyInThread });
        return { ok: true, value: 'om_progress_1' };
      },
      updateMessageById: async (messageId, content) => {
        updated.push({ messageId, content });
        return { ok: true, value: undefined };
      },
    },
    logger: noopLogger,
  });
  return { delivery, sent, updated };
}
