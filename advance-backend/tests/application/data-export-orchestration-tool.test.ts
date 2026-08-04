import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

describe('dataExport candidate orchestration tool contract', () => {
  it('routes candidate plans, samples, and sample confirmations through orchestration', async () => {
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
            status: 'sample_required' as const,
            planId,
            sampleRows: 100,
            reason: 'unknown_everything' as const,
          };
        },
        queueSample: async input => {
          calls.push({ kind: 'sample', input });
          return {
            status: 'sample_queued' as const,
            planId,
            sampleRunId: planId,
            exportJobId: 'sample-job-1',
            sampleRows: 100,
          };
        },
        confirmSample: async input => {
          calls.push({ kind: 'confirm_sample', input });
          return {
            status: 'full_queued' as const,
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
    const sample = await orchestrationTool.execute({ op: 'sample', planId }, ctx);
    const confirm = await orchestrationTool.execute({ op: 'confirm_sample', sampleRunId: planId }, ctx);

    assert.equal(plan.ok, true);
    assert.equal(plan.ok && plan.value.status, 'sample_required');
    assert.equal(sample.ok, true);
    assert.equal(sample.ok && sample.value.exportJobId, 'sample-job-1');
    assert.equal(confirm.ok, true);
    assert.equal(confirm.ok && confirm.value.exportJobId, 'full-job-1');
    assert.match(confirm.ok ? confirm.value.message : '', /format caps still apply/i);
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
      {
        kind: 'sample',
        input: {
          planId,
          companyId: 'co-test',
          userId: 'user-test',
          chatId: 'oc_chat',
        },
      },
      {
        kind: 'confirm_sample',
        input: {
          sampleRunId: planId,
          companyId: 'co-test',
          userId: 'user-test',
          chatId: 'oc_chat',
        },
      },
    ]);
  });

  it('keeps sample and sample-confirmation blocked results on the matching operation', async () => {
    const planId = '22222222-2222-4222-8222-222222222222';
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
        queueSample: async () => ({
          status: 'blocked' as const,
          reason: 'sample_not_ready',
          message: 'Review the sample first.',
        }),
        confirmSample: async () => ({
          status: 'blocked' as const,
          reason: 'plan_not_found',
          message: 'That sample is gone.',
        }),
      },
    });
    const ctx = makeCtx('dataExport', ['create'], { chatId: 'oc_chat' });

    const sample = await orchestrationTool.execute({ op: 'sample', planId }, ctx);
    const confirm = await orchestrationTool.execute({ op: 'confirm_sample', sampleRunId: planId }, ctx);

    assert.equal(sample.ok, true);
    assert.equal(sample.ok && sample.value.operation, 'sample');
    assert.equal(sample.ok && sample.value.planId, planId);
    assert.equal(confirm.ok, true);
    assert.equal(confirm.ok && confirm.value.operation, 'confirm_sample');
    assert.equal(confirm.ok && confirm.value.planId, planId);
  });
});
