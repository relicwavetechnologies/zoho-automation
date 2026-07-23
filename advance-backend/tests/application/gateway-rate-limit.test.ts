import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import { ConnectionRateLimitService } from '../../src/application/governance/connection-rate-limit.service.ts';
import type { ConnectionGovernanceRepository } from '../../src/application/governance/connection-governance.repository.ts';
import type { RateLimitCheck, RateLimitStore, RateLimitWindow } from '../../src/application/governance/rate-limit.port.ts';
import type { PermissionService } from '../../src/application/permissions/permission.service.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';
import { makeAllowedPerm, noopLogger } from '../tools/tool-test.helpers.ts';

class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  async inspect(windows: readonly RateLimitWindow[]) { return ok(this.state(windows, false)); }
  async consume(windows: readonly RateLimitWindow[]) {
    const current = this.state(windows, false);
    if (current.allowed) this.state(windows, true);
    return ok(current);
  }

  private state(windows: readonly RateLimitWindow[], increment: boolean): RateLimitCheck {
    const states = windows.map(window => ({
      ...window,
      used: this.counts.get(window.key) ?? 0,
      retryAfterSeconds: window.ttlSeconds,
    }));
    const allowed = states.every(window => window.used < window.limit);
    if (increment && allowed) for (const window of windows) {
      this.counts.set(window.key, (this.counts.get(window.key) ?? 0) + 1);
    }
    return { allowed, windows: states };
  }
}

describe('ToolExecutor connection rate limiting', () => {
  it('checks budget in preflight and atomically consumes it before a governed tool executes', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    const tool: Tool<{ connectionId: string }, { completed: boolean }> = {
      id: asToolId('fakeTool'),
      family: 'context',
      actionGroups: new Set(['read']),
      argsSchema: z.object({ connectionId: z.string().uuid() }),
      resultSchema: z.object({ completed: z.boolean() }),
      description: 'governed test tool',
      parameterDocs: 'connectionId: integration connection UUID',
      permissionCheck: () => ok('read'),
      execute: async () => {
        executions += 1;
        return ok({ completed: true });
      },
    };
    registry.register(tool);
    const repository: ConnectionGovernanceRepository = {
      findConnectionGovernance: async () => ok({
        managerPolicyJson: null,
        adminOverrideJson: {
          version: 1,
          actions: { read: { mode: 'enforced', requestsPerMinute: 1, requestsPerDay: null, approval: 'none' } },
        },
      }),
    };
    const limits = new ConnectionRateLimitService({
      repository,
      store: new MemoryRateLimitStore(),
      clock: { now: () => new Date('2026-07-22T12:00:00Z'), nowMs: () => 0 },
    });
    const permissions = {
      resolve: async () => ok(makeAllowedPerm('fakeTool', ['read'])),
      canInvoke: async () => ok(true),
      invalidateCompany: async () => {},
      invalidateDept: async () => {},
    } as unknown as PermissionService;
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions,
      connectionRateLimits: limits,
      logger: noopLogger,
      clock: { now: () => new Date('2026-07-22T12:00:00Z'), nowMs: () => 0 },
    });
    const member = { companyId: 'company-1', userId: 'user-1', aiRole: 'MEMBER', email: null, larkOpenId: null, sessionId: 'session-1' };
    const args = { connectionId: '00000000-0000-4000-8000-000000000001' };

    assert.equal((await executor.preflight({ member, toolId: 'fakeTool', args })).status, 'success');
    assert.equal((await executor.preflight({ member, toolId: 'fakeTool', args })).status, 'success');
    assert.equal((await executor.invoke({ member, toolId: 'fakeTool', args })).status, 'success');
    assert.equal((await executor.invoke({ member, toolId: 'fakeTool', args })).status, 'rate_limited');
    assert.equal(executions, 1);
  });
});
