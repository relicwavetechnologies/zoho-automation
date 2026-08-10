import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dataExportRunRequestId } from '../../src/application/data-export/export-request-identity.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

describe('dataExport candidate orchestration tool contract', () => {
  it('describes one backend-replayable provider export boundary', () => {
    const tool = createDataExportTool({ offers: {} as never });
    assert.match(tool.description, /backend-replayable provider exportCandidate/i);
    assert.match(tool.description, /company-owned, verified invoker-reader/i);
    assert.match(tool.parameterDocs, /Prefer an opaque backend-returned exportCandidate for every provider/i);
    assert.doesNotMatch(tool.description, /Never use.*Zoho/i);
  });

  it('routes an explicit candidate plan directly to the full export', async () => {
    const calls: unknown[] = [];
    const candidateId = '11111111-1111-4111-8111-111111111111';
    const planId = '22222222-2222-4222-8222-222222222222';
    const orchestrationTool = createDataExportTool({
      offers: {
        submitAuthorized: async () => 'unused',
      },
      orchestration: {
        planForActor: async input => {
          calls.push({ kind: 'plan', input });
          return {
            status: 'direct_queue' as const,
            planId,
            exportJobId: 'full-job-1',
          };
        },
      },
    });
    const ctx = makeCtx('dataExport', ['create'], {
      chatId: 'oc_chat',
      replyToMessageId: 'om_user',
    });

    const plan = await orchestrationTool.execute({
      op: 'plan',
      datasets: [{ candidateId, title: 'Semrush keywords' }],
      destination: { format: 'google_sheet', title: 'Semrush keywords' },
      userIntent: 'explicit_export',
    }, ctx);
    assert.equal(plan.ok, true);
    assert.equal(plan.ok && plan.value.status, 'direct_queue');
    assert.equal(plan.ok && plan.value.exportJobId, 'full-job-1');
    assert.deepEqual(calls, [
      {
        kind: 'plan',
        input: {
          companyId: 'co-test',
          userId: 'user-test',
          chatId: 'oc_chat',
          progressMessageId: 'om_user',
          plan: {
            datasets: [{ candidateId, title: 'Semrush keywords' }],
            destination: { format: 'google_sheet', title: 'Semrush keywords' },
            userIntent: 'explicit_export',
          },
        },
      },
    ]);
  });

  it('does not expose the removed sample operations in its schema', () => {
    const tool = createDataExportTool({ offers: {} as never });
    assert.equal(tool.argsSchema.safeParse({ op: 'sample', planId: '22222222-2222-4222-8222-222222222222' }).success, false);
    assert.equal(tool.argsSchema.safeParse({ op: 'confirm_sample', sampleRunId: '22222222-2222-4222-8222-222222222222' }).success, false);
    assert.equal(tool.argsSchema.safeParse({
      op: 'plan',
      datasets: [{ candidateId: '11111111-1111-4111-8111-111111111111' }],
      destination: { format: 'google_sheet', title: 'Old sample plan' },
      userIntent: 'sample_then_confirm',
    }).success, false);
    assert.doesNotMatch(tool.parameterDocs, /confirm_sample|op=sample|sample_required/);
  });

  it('routes list_candidates through orchestration with run scope defaults', async () => {
    const calls: unknown[] = [];
    const orchestrationTool = createDataExportTool({
      offers: {
        submitAuthorized: async () => 'unused',
      },
      orchestration: {
        planForActor: async () => ({
          status: 'blocked' as const,
          reason: 'unused',
          message: 'unused',
        }),
        listCandidatesForActor: async input => {
          calls.push(input);
          return [{
            candidateId: '11111111-1111-4111-8111-111111111111',
            label: 'Semrush backlinks comparison — a.com, b.com',
            previewRowCount: 2,
            estimatedRows: 2,
            columns: ['Domain', 'Backlinks'],
            shapeKey: 'semrush_snapshot:backlinks_comparison',
            sourceKind: 'semrush_snapshot',
            argsSummary: 'backlinks_comparison: a.com, b.com',
            createdAt: '2026-08-04T00:00:00.000Z',
          }];
        },
      },
    });
    const ctx = makeCtx('dataExport', ['create'], {
      chatId: 'oc_chat',
      runtimeRunId: 'run-123',
      traceId: 'trace-123',
    });

    const listed = await orchestrationTool.execute({ op: 'list_candidates' }, ctx);

    assert.equal(listed.ok, true);
    assert.equal(listed.ok && listed.value.operation, 'list_candidates');
    assert.equal(listed.ok && listed.value.candidates.length, 1);
    assert.match(listed.ok ? listed.value.message : '', /Found 1 active export candidate/i);
    assert.deepEqual(calls, [{
      companyId: 'co-test',
      userId: 'user-test',
      chatId: 'oc_chat',
      scope: 'run',
      runRequestId: dataExportRunRequestId(ctx.runContext, ctx.correlationId),
      traceId: 'trace-123',
    }]);
  });
});
