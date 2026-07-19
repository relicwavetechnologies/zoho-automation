import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher';
import { ToolExecutor } from '../../src/application/gateway/tool-executor';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry';
import { makeAllowedPerm, noopLogger } from '../tools/tool-test.helpers';

const member = {
  companyId: 'company-1', userId: 'manager-1', aiRole: 'MEMBER', email: null,
  larkOpenId: null, sessionId: 'member-session-1',
};

describe('gateway interactive Teach operations', () => {
  it('binds evidence and persona writes to the authenticated manager and active department', async () => {
    const calls: unknown[] = [];
    const permissions = {
      resolve: async () => ({ ok: true as const, value: makeAllowedPerm('webSearch', ['read']) }),
      canInvoke: async () => ({ ok: true as const, value: true }),
      invalidateCompany: async () => {},
      invalidateDept: async () => {},
    } as any;
    const registry = new ToolRegistry();
    const dispatcher = new GatewayDispatcher({
      permissions,
      toolRegistry: registry,
      skillCatalog: {} as any,
      toolExecutor: new ToolExecutor({
        toolRegistry: registry,
        permissions,
        logger: noopLogger,
        clock: { now: () => new Date(), nowMs: () => Date.now() },
      }),
      managerTeachService: {
        getAgentContext: async (input: unknown) => {
          calls.push({ operation: 'context', input });
          return { teachSessionId: '29a63a44-c348-4414-b5eb-25246d7eb13d', evidence: { baseRevision: 1 } };
        },
        applyAgentLearning: async (input: unknown) => {
          calls.push({ operation: 'apply', input });
          return { sessionId: '29a63a44-c348-4414-b5eb-25246d7eb13d', status: 'completed', appliedChangeCount: 0 };
        },
      } as any,
      logger: noopLogger,
    });
    const sessionId = '29a63a44-c348-4414-b5eb-25246d7eb13d';
    const context = await dispatcher.dispatch({
      op: 'teach.context.get', departmentId: 'department-1', payload: { teachSessionId: sessionId },
    }, member);
    assert.equal(context.ok, true);

    const applied = await dispatcher.dispatch({
      op: 'teach.learning.apply',
      departmentId: 'department-1',
      payload: {
        teachSessionId: sessionId,
        mutationKey: 'teach-initial-write-001',
        patch: {
          schemaVersion: 2,
          baseRevision: 1,
          understanding: 'No durable rule.',
          readiness: {
            classifications: ['no_learning'], outcome: 'No durable learning.', whenToUse: 'Not applicable.',
            inputs: null, expectedOutput: null, decisionRules: null, exceptions: null,
            automationTrigger: null, monitoringScope: null, autonomyBoundary: null, failureHandling: null,
            clarificationAnswers: [], unresolvedMaterialQuestions: [],
          },
          skills: [], changes: [],
        },
      },
    }, member);
    assert.equal(applied.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual((calls[0] as any).input, {
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId,
    });

    const missingDepartment = await dispatcher.dispatch({
      op: 'teach.context.get', payload: { teachSessionId: sessionId },
    }, member);
    assert.equal(missingDepartment.status, 'bad_request');
  });
});
