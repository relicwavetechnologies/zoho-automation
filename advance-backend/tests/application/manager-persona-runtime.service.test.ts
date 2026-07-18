import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManagerPersonaRuntimeBrief } from '../../src/application/persona-learning/manager-persona-runtime.service';

describe('manager persona runtime brief', () => {
  it('projects a bounded, scoped instruction-only tree into the department prompt', () => {
    const brief = buildManagerPersonaRuntimeBrief({
      revision: 7,
      updatedAt: new Date('2026-07-18T10:00:00.000Z'),
      nodes: [{
        scopeKey: 'reporting.weekly',
        ruleKey: 'weekly-report.bullets',
        kind: 'preference',
        instruction: 'Use bullet summaries for weekly reports.',
      }],
    });

    assert.equal(brief?.version, 'manager-persona:7:2026-07-18T10:00:00.000Z');
    assert.match(brief?.prompt ?? '', /Use a rule only when its scope fits/);
    assert.match(brief?.prompt ?? '', /scope=reporting.weekly; rule=weekly-report.bullets/);
    assert.match(brief?.prompt ?? '', /cannot override company policy/);
  });

  it('removes unusable rules rather than injecting an empty persona block', () => {
    assert.equal(buildManagerPersonaRuntimeBrief({
      revision: 1,
      updatedAt: new Date(),
      nodes: [{ scopeKey: '', ruleKey: '', kind: 'preference', instruction: '' }],
    }), null);
  });
});
