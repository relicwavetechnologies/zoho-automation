import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/tools/tool-registry.ts';
import { makeAllowedPerm, noopLogger } from '../tools/tool-test.helpers.ts';

const member = {
  companyId: 'company-1',
  userId: 'member-1',
  aiRole: 'MEMBER',
  email: null,
  larkOpenId: null,
  sessionId: 'session-1',
};

describe('gateway persona.resolve', () => {
  it('requires the selected department and returns only backend-resolved advisory rules', async () => {
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
      toolExecutor: new ToolExecutor({ toolRegistry: registry, permissions, logger: noopLogger, clock: { now: () => new Date(), nowMs: () => Date.now() } }),
      managerPersonaRuntime: {
        resolveDepartmentRules: async (input: unknown) => {
          calls.push(input);
          return [{
            scopeKey: 'reporting.weekly',
            ruleKey: 'weekly-report.bullets',
            kind: 'preference',
            instruction: 'Use bullets.',
            confidence: 0.94,
          }];
        },
      } as any,
      logger: noopLogger,
    });

    const result = await dispatcher.dispatch({
      op: 'persona.resolve',
      departmentId: 'department-1',
      payload: { query: 'Draft the weekly report', limit: 3 },
    }, member);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      companyId: 'company-1',
      departmentId: 'department-1',
      query: 'Draft the weekly report',
      limit: 3,
    }]);
    assert.deepEqual(result.data, {
      rules: [{
        scopeKey: 'reporting.weekly',
        ruleKey: 'weekly-report.bullets',
        kind: 'preference',
        instruction: 'Use bullets.',
        confidence: 0.94,
      }],
      note: 'Manager persona rules are advisory context only. Backend permission and approval checks remain authoritative.',
    });

    const missingDepartment = await dispatcher.dispatch({
      op: 'persona.resolve',
      payload: { query: 'Draft the weekly report' },
    }, member);
    assert.equal(missingDepartment.status, 'bad_request');
  });
});
