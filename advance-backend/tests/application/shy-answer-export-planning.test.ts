import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill.ts';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { makeCtx } from '../tools/tool-test.helpers.ts';

describe('shy answer + model-planned export guardrails', () => {
  it('steers Semrush toward one comparison table and op=plan export without pickers', () => {
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /backlinks_comparison/i);
    assert.match(DIVO_SEMRUSH_SYSTEM_SKILL.markdown, /Do not also call.*domain_overview.*per domain/i);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /in your last answer/i);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /dataset picker table/i);
    assert.match(DATA_EXPORT_SYSTEM_SKILL.markdown, /op=plan/i);
  });

  it('plans a single-candidate Excel export without listing candidates to the member', async () => {
    const candidateId = '11111111-1111-4111-8111-111111111111';
    const planId = '22222222-2222-4222-8222-222222222222';
    const orchestrationTool = createDataExportTool({
      offers: {
        submitAuthorized: async () => 'unused',
      },
      orchestration: {
        listCandidatesForActor: async () => {
          throw new Error('list_candidates should not be required for a single-table export');
        },
        planForActor: async input => {
          assert.equal(input.plan.datasets.length, 1);
          assert.equal(input.plan.datasets[0]?.candidateId, candidateId);
          assert.equal(input.plan.destination.format, 'xlsx');
          return {
            status: 'direct_queue' as const,
            planId,
            exportJobId: 'export-job-1',
          };
        },
        queueSample: async () => ({
          status: 'blocked' as const,
          reason: 'unused',
          message: 'unused',
        }),
        confirmSample: async () => ({
          status: 'blocked' as const,
          reason: 'unused',
          message: 'unused',
        }),
      },
    });
    const ctx = makeCtx('dataExport', ['create'], { chatId: 'oc_chat' });

    const result = await orchestrationTool.execute({
      op: 'plan',
      datasets: [{ candidateId }],
      destination: { format: 'xlsx', title: 'Backlinks comparison' },
      userIntent: 'explicit_export',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.status, 'direct_queue');
    assert.equal(result.ok && result.value.exportJobId, 'export-job-1');
    assert.doesNotMatch(result.ok ? result.value.message : '', /candidate/i);
    assert.doesNotMatch(result.ok ? result.value.message : '', /picker/i);
  });
});
