import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildManagerPersonaRuntimeBrief,
  rankManagerPersonaRules,
} from '../../src/application/persona-learning/manager-persona-runtime.service';

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
        skillLinks: [{
          skill: {
            id: 'skill-weekly-report',
            slug: 'weekly-risk-report',
            name: 'Weekly Risk Report',
            summary: 'Prepare weekly reports.',
            revision: 3,
          },
        }],
      }],
    });

    assert.equal(brief?.version, 'manager-persona:7:2026-07-18T10:00:00.000Z');
    assert.match(brief?.prompt ?? '', /TREE INDEX/);
    assert.match(brief?.prompt ?? '', /call divo_skill_resolve/);
    assert.match(brief?.prompt ?? '', /scope=reporting.weekly; rule=weekly-report.bullets/);
    assert.match(brief?.prompt ?? '', /cannot override company policy/);
    assert.match(brief?.prompt ?? '', /linkedSkills=weekly-risk-report \(skillId=skill-weekly-report; revision=3\)/);
    assert.match(brief?.prompt ?? '', /Do not separately fuzzy-search or reload/);
    assert.doesNotMatch(brief?.prompt ?? '', /Use bullet summaries/);
  });

  it('removes unusable rules rather than injecting an empty persona block', () => {
    assert.equal(buildManagerPersonaRuntimeBrief({
      revision: 1,
      updatedAt: new Date(),
      nodes: [{ scopeKey: '', ruleKey: '', kind: 'preference', instruction: '' }],
    }), null);
  });

  it('ranks task-specific branches using scopes, instructions, and linked skill metadata', () => {
    const ranked = rankManagerPersonaRules('Prepare the weekly risk reports', [
      {
        scopeKey: 'email.monitoring', ruleKey: 'email.daily-summary', kind: 'workflow',
        instruction: 'Summarize daily email.', confidence: 0.99,
        skillLinks: [{ skill: { slug: 'gmail-summary', name: 'Gmail Summary', summary: 'Summarize inbox messages.' } }],
      },
      {
        scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first', kind: 'workflow',
        instruction: 'Lead the weekly report with risks.', confidence: 0.95,
        skillLinks: [{ skill: { slug: 'weekly-risk-report', name: 'Weekly Risk Report', summary: 'Prepare reports.' } }],
      },
    ], 2);

    assert.equal(ranked[0]?.node.ruleKey, 'weekly-report.risks-first');
    assert.deepEqual(ranked[0]?.score.matchedOn, ['scope', 'rule', 'instruction', 'skill']);
  });
});
