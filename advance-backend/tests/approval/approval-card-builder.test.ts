import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApprovalCard,
  buildApprovalResolutionCard,
} from '../../src/application/approval/approval-card-builder.ts';

function parseCard(envelope: string): Record<string, unknown> {
  const parsed = JSON.parse(envelope) as { card: string };
  return JSON.parse(parsed.card) as Record<string, unknown>;
}

describe('approval card presentation', () => {
  it('renders department memory approval with human names and no internal identifiers', () => {
    const card = parseCard(buildApprovalCard({
      approvalId: 'approval-secret-id',
      toolId: 'knowledge',
      action: 'create',
      args: {
        operation: 'apply',
        kind: 'memory',
        action: 'publish',
        scope: 'department',
        departmentId: '9c12685b-13c2-48de-9378-b52a7d13b701',
        mutationId: 'mutation-secret-id',
        contentHash: 'a'.repeat(64),
        content: { facts: ['Tech Testing weekly QA cutoff is Friday at 5 PM.'] },
      },
      summary: 'Publish 1 reviewed fact to department memory',
      requesterName: 'Anish Suman',
      approverName: 'Abhishek Verma',
      authority: 'department_manager',
      departmentName: 'Tech Testing',
    }));
    const visible = JSON.stringify(card);

    assert.match(visible, /Department memory approval/);
    assert.match(visible, /Anish Suman/);
    assert.match(visible, /Abhishek Verma/);
    assert.match(visible, /Department manager/);
    assert.match(visible, /Tech Testing/);
    assert.match(visible, /weekly QA cutoff is Friday at 5 PM/);
    assert.match(visible, /Nothing has been saved yet/);
    assert.doesNotMatch(visible, /ou_[a-z\d]+/i);
    assert.doesNotMatch(visible, /9c12685b-13c2-48de-9378-b52a7d13b701/);
    assert.doesNotMatch(visible, /mutation-secret-id/);
    assert.doesNotMatch(visible, /target=department/);

    const buttonPayload = visible.match(/approval-secret-id/);
    assert.ok(buttonPayload, 'approval ID remains only in the hidden button value');
  });

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

  it('humanizes generic tool and action identifiers', () => {
    const card = parseCard(buildApprovalCard({
      approvalId: 'approval-id',
      toolId: 'googleGmail',
      action: 'send',
      args: { to: ['manager@example.com'] },
      summary: 'Send the Q2 report to manager@example.com.',
      requesterName: 'Anish Suman',
      approverName: 'Abhishek Verma',
      authority: 'department_manager',
      departmentName: 'Tech Testing',
    }));
    const visible = JSON.stringify(card);

    assert.match(visible, /Google Gmail request/);
    assert.match(visible, /Send/);
    assert.doesNotMatch(visible, /googleGmail/);
  });
});
