import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkDecisionCardHandler } from '../../../src/infrastructure/channels/lark/lark-decision-card.handler.ts';
import {
  buildDecisionCardData,
  buildDecisionResolvedCardData,
} from '../../../src/infrastructure/channels/lark/lark-decision-card.ts';
import type { DecisionService } from '../../../src/application/decision/decision.service.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

describe('LarkDecisionCardHandler', () => {
  it('renders skill review and resolution without a colored header strip', () => {
    const card = buildDecisionCardData({
      decision: {
        id: 'decision-1',
        title: 'Update Cursor Design HTML',
        evidence: {
          kind: 'skill',
          action: 'update',
          name: 'Cursor Design HTML',
          summary: 'Adds 1 instruction line.',
          fieldChanges: [],
          instructionChanges: [
            { kind: 'context', text: '- [ ] Responsive: cards collapse to 1-up below 640px.' },
            { kind: 'added', text: '- [ ] Check the interface at a narrow mobile width.' },
          ],
          contentHash: 'a'.repeat(64),
        },
      } as any,
      questions: [{
        id: 'confirm',
        ask: 'Apply this change from the next turn?',
        pick: 'one',
        options: [
          { value: 'yes', label: 'Approve', settles: 'approved', tone: 'primary' },
          { value: 'no', label: 'Reject', settles: 'rejected', tone: 'danger' },
        ],
      }] as any,
    });
    assert.ok(card);
    assert.equal(card['header'], undefined);
    assert.match(JSON.stringify(card), /Update Cursor Design HTML/);
    assert.match(JSON.stringify(card), /narrow mobile width/);

    const resolved = buildDecisionResolvedCardData({
      title: 'Update Cursor Design HTML',
      verdict: 'approved',
      summary: 'Approve',
      result: 'Updated Cursor Design HTML at revision 2. Divo will use it from the next turn.',
      resultLabel: 'Applied',
      byName: 'Manager',
      at: new Date('2026-08-22T01:23:00.000Z'),
    });
    assert.equal(resolved['header'], undefined);
    assert.match(JSON.stringify(resolved), /revision 2/);
    assert.doesNotMatch(JSON.stringify(resolved), /"template":"green"/);
  });

  it('tells a gateway requester to retry after approval instead of claiming Divo is continuing', async () => {
    const decisions = {
      answerOne: async () => ({
        settled: true as const,
        ok: true as const,
        verdict: 'approved' as const,
        decision: {
          id: 'decision-1',
          title: 'Send the report',
        },
        summary: 'Approved',
        followUp: 'retry' as const,
      }),
    } as unknown as DecisionService;
    const handler = new LarkDecisionCardHandler(decisions, logger);

    const result = await handler.handle({
      action: {
        value: {
          kind: 'decision_answer',
          decisionId: 'decision-1',
          questionId: 'confirm',
          value: 'yes',
        },
      },
    }, {
      tenantKey: 'tenant-1',
      openId: 'ou_manager',
      userId: 'manager-1',
      companyId: 'company-1',
      displayName: 'Manager',
    });

    const toast = (result.responseBody as any).toast;
    assert.equal(toast.type, 'success');
    assert.match(toast.content, /retry the exact action/i);
    assert.doesNotMatch(toast.content, /Divo is carrying on/i);
  });

  it('labels a distinct-authority skill outcome as waiting rather than applied', async () => {
    const decisions = {
      answerOne: async () => ({
        settled: true as const,
        ok: true as const,
        verdict: 'approved' as const,
        decision: {
          id: 'decision-1',
          title: 'Update Cursor Design HTML',
          evidence: {
            kind: 'skill',
            action: 'update',
            name: 'Cursor Design HTML',
            summary: 'Adds 1 instruction line.',
            fieldChanges: [],
            instructionChanges: [],
            contentHash: 'a'.repeat(64),
          },
        },
        summary: 'Approve',
        followUp: 'waiting' as const,
        execution: { message: 'The exact skill change is waiting for department-manager approval.' },
      }),
    } as unknown as DecisionService;
    const handler = new LarkDecisionCardHandler(decisions, logger);

    const result = await handler.handle({
      action: {
        value: {
          kind: 'decision_answer',
          decisionId: 'decision-1',
          questionId: 'confirm',
          value: 'yes',
        },
      },
    }, {
      tenantKey: 'tenant-1',
      openId: 'ou_requester',
      userId: 'requester-1',
      companyId: 'company-1',
    });

    const card = (result.responseBody as any).card.data;
    assert.match(JSON.stringify(card), /Waiting for approval/);
    assert.doesNotMatch(JSON.stringify(card), /\*\*Applied\*\*/);
  });
});
