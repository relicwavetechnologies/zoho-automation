import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoogleDriveXlsxConversionWorker,
  type GoogleDriveXlsxConversionCompletion,
  type GoogleDriveXlsxConversionWorkerDeps,
} from '../../src/application/data-export/google-drive-xlsx-conversion.worker.ts';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope.ts';

const job = {
  jobKey: 'conversion_offer_123',
  companyId: 'company-1',
  userId: 'user-1',
  departmentId: '22222222-2222-4222-8222-222222222222',
  conversationKey: 'thread-1',
  sourceConnectionId: '11111111-1111-4111-8111-111111111111',
  sourceFileId: 'source_xlsx_123',
  sourceTitle: 'Quarterly budget.xlsx',
} as const;

function createDeps(overrides: Partial<GoogleDriveXlsxConversionWorkerDeps> = {}) {
  const calls = {
    download: 0,
    import: 0,
    sourceMetadata: 0,
    complete: 0,
    continuity: 0,
    progress: [] as string[],
    delivered: [] as GoogleDriveXlsxConversionCompletion[],
    failures: [] as string[],
  };
  let completion: GoogleDriveXlsxConversionCompletion | undefined;
  const deps: GoogleDriveXlsxConversionWorkerDeps = {
    checkpoints: {
      claim: async () => completion
        ? { status: 'completed' as const, completion }
        : { status: 'claimed' as const },
      complete: async value => {
        calls.complete += 1;
        completion = value;
        return value;
      },
    },
    identity: {
      resolve: async () => ({ companyId: job.companyId, userId: job.userId, active: true }),
    },
    permissions: {
      canReadDriveXlsx: async () => true,
      canCreateGoogleSheet: async () => true,
    },
    connections: {
      resolve: async () => ({
        connectionId: job.sourceConnectionId,
        companyId: job.companyId,
        ownerType: 'user',
        ownerUserId: job.userId,
        status: 'connected',
        accountEmail: 'person@example.com',
        scopes: [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.sheetsFull],
      }),
    },
    drive: {
      getSourceMetadata: async () => {
        calls.sourceMetadata += 1;
        return {
          id: job.sourceFileId,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          trashed: false,
          capabilities: { canDownload: true, canCopy: true },
        };
      },
      downloadXlsx: async () => {
        calls.download += 1;
        return (async function* () { yield new Uint8Array([1, 2, 3]); })();
      },
      findCreatedSheet: async () => null,
      importXlsxAsNewSheet: async input => {
        calls.import += 1;
        assert.equal(input.connectionId, job.sourceConnectionId);
        assert.equal(input.sourceFileId, job.sourceFileId);
        assert.equal(input.idempotencyKey, job.jobKey);
        for await (const _ of input.content) {
          // Consume the stream: the real adapter must receive the original bytes once.
        }
        return { spreadsheetId: 'new_sheet_456' };
      },
      getCreatedSheetMetadata: async () => ({
        id: 'new_sheet_456',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        trashed: false,
        ownerEmail: 'person@example.com',
        webViewLink: 'https://docs.google.com/spreadsheets/d/new_sheet_456/edit?usp=drive_link',
      }),
    },
    continuity: {
      record: async () => { calls.continuity += 1; },
    },
    delivery: {
      progress: async input => { calls.progress.push(input.content); },
      completed: async input => { calls.delivered.push(input.completion); },
      failed: async input => { calls.failures.push(input.content); },
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('GoogleDriveXlsxConversionWorker', () => {
  it('imports a streamed XLSX as a new verified Google Sheet without changing the source', async () => {
    const { deps, calls } = createDeps();
    const result = await new GoogleDriveXlsxConversionWorker(deps).process(job, { finalAttempt: true });

    assert.equal(result.disposition, 'completed');
    if (result.disposition !== 'completed') return;
    assert.deepEqual(result.completion, {
      jobKey: job.jobKey,
      sourceFileId: job.sourceFileId,
      spreadsheetId: 'new_sheet_456',
      artifactUrl: 'https://docs.google.com/spreadsheets/d/new_sheet_456/edit',
      ownerEmail: 'person@example.com',
      verified: true,
    });
    assert.equal(calls.sourceMetadata, 1);
    assert.equal(calls.download, 1);
    assert.equal(calls.import, 1);
    assert.equal(calls.complete, 1);
    assert.equal(calls.continuity, 1);
    assert.equal(calls.failures.length, 0);
    assert.match(calls.progress[0]!, /original Excel file will not be changed/);
  });

  it('reuses the durable completion on retry instead of importing another Sheet', async () => {
    const { deps, calls } = createDeps();
    const worker = new GoogleDriveXlsxConversionWorker(deps);
    await worker.process(job, { finalAttempt: false });
    const retry = await worker.process(job, { finalAttempt: true });

    assert.equal(retry.disposition, 'completed');
    assert.equal(calls.import, 1);
    assert.equal(calls.download, 1);
    assert.equal(calls.complete, 1);
    assert.equal(calls.delivered.length, 2);
  });

  it('retries continuity after the verified Sheet was checkpointed', async () => {
    let continuityAttempts = 0;
    const { deps, calls } = createDeps({
      continuity: {
        record: async () => {
          continuityAttempts += 1;
          if (continuityAttempts === 1) throw new Error('conversation store unavailable');
          calls.continuity += 1;
        },
      },
    });
    const worker = new GoogleDriveXlsxConversionWorker(deps);
    await assert.rejects(worker.process(job, { finalAttempt: false }), /conversation store unavailable/);
    const retry = await worker.process(job, { finalAttempt: true });

    assert.equal(retry.disposition, 'completed');
    assert.equal(calls.import, 1);
    assert.equal(calls.download, 1);
    assert.equal(continuityAttempts, 2);
    assert.equal(calls.continuity, 1);
  });

  it('does not import when identity, permission, or source access is revoked and only delivers safe failure copy', async () => {
    const cases: readonly [string, Partial<GoogleDriveXlsxConversionWorkerDeps>][] = [
      ['identity', {
        identity: { resolve: async () => ({ companyId: job.companyId, userId: job.userId, active: false }) },
      }],
      ['permission', {
        permissions: { canReadDriveXlsx: async () => true, canCreateGoogleSheet: async () => false },
      }],
      ['source', {
        drive: {
          ...createDeps().deps.drive,
          getSourceMetadata: async () => ({
            id: job.sourceFileId,
            mimeType: 'text/plain',
            trashed: false,
            capabilities: { canDownload: true, canCopy: true },
          }),
        },
      }],
    ];

    for (const [name, overrides] of cases) {
      const { deps, calls } = createDeps(overrides);
      await assert.rejects(
        new GoogleDriveXlsxConversionWorker(deps).process(job, { finalAttempt: true }),
        { name: 'GoogleDriveXlsxConversionError' },
        name,
      );
      assert.equal(calls.import, 0, name);
      assert.equal(calls.failures.length, 1, name);
      assert.equal(calls.failures[0], 'Divo could not convert this Excel workbook. The original file was not changed. Please try again shortly.', name);
    }
  });

  it('delivers an unrecoverable denial on the first attempt', async () => {
    const { deps, calls } = createDeps({
      identity: { resolve: async () => ({ companyId: job.companyId, userId: job.userId, active: false }) },
    });
    await assert.rejects(
      new GoogleDriveXlsxConversionWorker(deps).process(job, { finalAttempt: false }),
      { name: 'GoogleDriveXlsxConversionError' },
    );
    assert.equal(calls.failures.length, 1);
  });
});
