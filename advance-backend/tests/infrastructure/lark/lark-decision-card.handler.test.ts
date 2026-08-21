import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkDecisionCardHandler } from '../../../src/infrastructure/channels/lark/lark-decision-card.handler.ts';
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
});
