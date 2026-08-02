import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkbookConversionContinuityRecorder } from '../../src/application/data-export/workbook-conversion-continuity.ts';
import { ok } from '../../src/shared/result.ts';

describe('workbook conversion continuity', () => {
  it('records one conversation-scoped opaque Sheet reference without inventing a row count', async () => {
    let recorded: any;
    const recorder = new WorkbookConversionContinuityRecorder({
      appendTurn: async (...args: any[]) => {
        recorded = args;
        return ok(undefined);
      },
    });
    await recorder.record({
      job: {
        jobKey: 'wbc_offer',
        companyId: 'company-1',
        userId: 'user-1',
        conversationKey: 'thread-1',
        sourceConnectionId: '11111111-1111-4111-8111-111111111111',
        sourceFileId: 'source-xlsx',
        sourceTitle: 'Budget.xlsx',
      },
      completion: {
        jobKey: 'wbc_offer',
        sourceFileId: 'source-xlsx',
        spreadsheetId: 'converted-sheet',
        artifactUrl: 'https://docs.google.com/spreadsheets/d/converted-sheet/edit',
        ownerEmail: 'person@example.com',
        verified: true,
      },
    });

    assert.equal(recorded[0], 'thread-1');
    assert.equal(recorded[1].toolOutcome.artifactType, 'google_sheet');
    assert.equal(recorded[1].toolOutcome.connectionId, '11111111-1111-4111-8111-111111111111');
    assert.equal('rowCount' in recorded[1].toolOutcome, false);
    assert.deepEqual(recorded[2], { companyId: 'company-1', channel: 'lark' });
    assert.deepEqual(recorded[3], { dedupeKey: 'workbook-conversion:wbc_offer:resource' });
  });
});
