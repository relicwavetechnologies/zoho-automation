import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApprovalResolutionCard } from '../../src/application/approval/approval-card-builder.ts';

function parseCard(envelope: string): Record<string, unknown> {
  const parsed = JSON.parse(envelope) as { card: string };
  return JSON.parse(parsed.card) as Record<string, unknown>;
}

describe('approval card presentation', () => {
  it('keeps the human request visible after the decision', () => {
    const card = parseCard(buildApprovalResolutionCard(
      'approved',
      'Abhishek Verma',
      new Date('2026-07-31T03:45:00.000Z'),
      {
        toolId: 'knowledge',
        action: 'create',
        args: {
          operation: 'apply',
          kind: 'memory',
          action: 'publish',
          scope: 'department',
          departmentId: 'internal-department-id',
          mutationId: 'internal-mutation-id',
          contentHash: 'b'.repeat(64),
          content: { facts: ['QA cutoff is Friday at 5 PM.'] },
        },
        summary: 'internal summary',
        requesterName: 'Anish Suman',
        authority: 'department_manager',
        departmentName: 'Tech Testing',
      },
    ));
    const visible = JSON.stringify(card);

    assert.match(visible, /Approved by Abhishek Verma/);
    assert.match(visible, /Anish Suman/);
    assert.match(visible, /QA cutoff is Friday at 5 PM/);
    assert.doesNotMatch(visible, /internal-department-id/);
    assert.doesNotMatch(visible, /internal-mutation-id/);
  });

});
