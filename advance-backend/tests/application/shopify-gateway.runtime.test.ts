import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { ToolExecutor } from '../../src/application/gateway/tool-executor';
import { classifyShopifyProtectedResult } from '../../src/application/shopify/shopify-protected-result';
import { ToolRegistry } from '../../src/application/tools/tool-registry';
import type { Tool } from '../../src/application/tools/tool.contract';
import { PermissionError } from '../../src/shared/errors';
import { asToolId } from '../../src/shared/ids';
import { err, ok } from '../../src/shared/result';
import { makeAllowedPerm, noopLogger } from '../tools/tool-test.helpers';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('Shopify runtime gateway integration', () => {
  it('marks zero-result customer and order reads protected without inventing subject refs', () => {
    for (const [toolId, operation] of [
      ['shopifyCustomers', 'count_customers'],
      ['shopifyOrders', 'list_orders'],
    ] as const) {
      assert.deepEqual(classifyShopifyProtectedResult({
        toolId,
        args: { connectionId, operation },
        result: { status: 'empty', operation, data: toolId === 'shopifyCustomers' ? { count: 0 } : [] },
      }), {
        used: true,
        provider: 'shopify',
        connectionId,
        category: toolId === 'shopifyCustomers' ? 'customers' : 'orders',
        references: [],
      });
    }
  });

  it('centrally selects the only accessible Shopify connection before schema validation', async () => {
    let executedArgs: unknown;
    const executor = buildExecutor({
      connections: [connection('Store A', connectionId)],
      execute: async args => {
        executedArgs = args;
        return ok({ rows: 1 });
      },
    });

    const outcome = await executor.executeForRuntime(runtimeInput({ args: {
      operation: 'sales_summary',
    } }));

    assert.equal(outcome.status, 'success');
    assert.deepEqual(executedArgs, { connectionId, operation: 'sales_summary' });
  });

  it('does not guess when multiple stores are accessible and returns only public choices', async () => {
    const executor = buildExecutor({
      connections: [
        connection('Store A', connectionId),
        connection('Store B', '22222222-2222-4222-8222-222222222222'),
      ],
    });

    const outcome = await executor.executeForRuntime(runtimeInput({ args: { operation: 'sales_summary' } }));

    assert.equal(outcome.status, 'invalid_args');
    assert.match(outcome.message ?? '', /More than one Shopify account/);
    assert.doesNotMatch(outcome.message ?? '', /token|secret|refresh/i);
  });

  it('stops at the centralized approval gate before Shopify execution', async () => {
    let executions = 0;
    let approvedArgs: unknown;
    const executor = buildExecutor({
      connections: [connection('Store A', connectionId)],
      execute: async () => {
        executions += 1;
        return ok({ rows: 1 });
      },
    });
    const outcome = await executor.executeForRuntime(runtimeInput({
      args: { operation: 'sales_summary' },
      chatId: 'chat-1',
      approvalGate: {
        check: async (input: Record<string, unknown>) => {
          approvedArgs = input['args'];
          return {
            kind: 'pending',
            approvalId: 'approval-1',
            authority: 'connection_owner',
            message: 'Owner approval required',
          };
        },
      } as never,
    }));

    assert.equal(outcome.status, 'approval_required');
    assert.equal(outcome.approvalId, 'approval-1');
    assert.deepEqual(approvedArgs, { connectionId, operation: 'sales_summary' });
    assert.equal(executions, 0);
  });

  it('stamps backend-owned Shopify provenance before and after a successful customer result', async () => {
    const protectedRuns: unknown[] = [];
    const shopifyRuns: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('shopifyCustomers'),
      family: 'shopify',
      actionGroups: new Set(['read']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        operation: z.literal('get_customer'),
        customerId: z.string(),
      }).strict(),
      resultSchema: z.object({ data: z.object({ id: z.string(), tags: z.array(z.string()) }) }),
      description: 'Shopify customer test tool',
      parameterDocs: 'closed test contract',
      permissionCheck: () => ok('read'),
      execute: async args => ok({ data: { id: args.customerId, tags: ['vip'] } }),
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: {} as never,
      connectionRegistry: shopifyConnectionRegistry(),
      protectedDataRuns: { observe: async input => { protectedRuns.push(input); } },
      shopifyDataRuns: { record: async input => { shopifyRuns.push(input); } },
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const outcome = await executor.executeForRuntime({
      toolId: 'shopifyCustomers',
      args: {
        connectionId,
        operation: 'get_customer',
        customerId: 'gid://shopify/Customer/42',
      },
      runContext: {
        companyId: 'company-1',
        userId: 'user-1',
        companyRole: 'MEMBER',
        channel: 'lark',
        traceId: 'run-1',
        chatId: 'thread-1',
      },
      execution: { version: 1, runId: 'run-1', threadId: 'thread-1', actionId: 'action-1' },
      perm: makeAllowedPerm('shopifyCustomers', ['read']),
    } as never);

    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.protectedData, {
      used: true,
      provider: 'shopify',
      connectionId,
      category: 'customers',
      references: [{
        provider: 'shopify',
        connectionId,
        resourceType: 'customer',
        resourceId: 'gid://shopify/Customer/42',
      }],
    });
    assert.deepEqual(protectedRuns, [{
      companyId: 'company-1',
      userId: 'user-1',
      channel: 'lark',
      runId: 'run-1',
      threadId: 'thread-1',
    }]);
    const expectedShopifyRun = {
      companyId: 'company-1',
      userId: 'user-1',
      channel: 'lark',
      runId: 'run-1',
      threadId: 'thread-1',
      connectionId,
      toolId: 'shopifyCustomers',
    };
    assert.deepEqual(shopifyRuns, [expectedShopifyRun, expectedShopifyRun]);
  });

  it('does not call Shopify when the initial durable shop stamp fails', async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('shopifyCustomers'),
      family: 'shopify',
      actionGroups: new Set(['read']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        operation: z.literal('get_customer'),
        customerId: z.string(),
      }).strict(),
      resultSchema: z.object({ data: z.object({ id: z.string() }) }),
      description: 'Shopify customer test tool',
      parameterDocs: 'closed test contract',
      permissionCheck: () => ok('read'),
      execute: async args => {
        executed = true;
        return ok({ data: { id: args.customerId } });
      },
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: {} as never,
      connectionRegistry: shopifyConnectionRegistry(),
      protectedDataRuns: { observe: async () => undefined },
      shopifyDataRuns: { record: async () => { throw new Error('stamp unavailable'); } },
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const outcome = await executor.executeForRuntime({
      toolId: 'shopifyCustomers',
      args: {
        connectionId,
        operation: 'get_customer',
        customerId: 'gid://shopify/Customer/42',
      },
      runContext: {
        companyId: 'company-1',
        userId: 'user-1',
        companyRole: 'MEMBER',
        channel: 'lark',
        traceId: 'run-1',
        chatId: 'thread-1',
      },
      execution: { version: 1, runId: 'run-1', threadId: 'thread-1', actionId: 'action-1' },
      perm: makeAllowedPerm('shopifyCustomers', ['read']),
    } as never);

    assert.equal(outcome.status, 'tool_error');
    assert.equal(executed, false);
  });

  it('fails closed before protected tool execution when durable run protection fails', async () => {
    let executed = false;
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('shopifyCustomers'),
      family: 'shopify',
      actionGroups: new Set(['read']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        operation: z.literal('count_customers'),
      }).strict(),
      resultSchema: z.object({ data: z.object({ count: z.number() }) }),
      description: 'Shopify customer test tool',
      parameterDocs: 'closed test contract',
      permissionCheck: () => ok('read'),
      execute: async () => {
        executed = true;
        return ok({ data: { count: 1 } });
      },
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: {} as never,
      connectionRegistry: shopifyConnectionRegistry(),
      protectedDataRuns: { observe: async () => { throw new Error('database unavailable'); } },
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const outcome = await executor.executeForRuntime({
      toolId: 'shopifyCustomers',
      args: { connectionId, operation: 'count_customers' },
      runContext: {
        companyId: 'company-1',
        userId: 'user-1',
        companyRole: 'MEMBER',
        channel: 'desktop',
      },
      execution: { version: 1, runId: 'run-1', threadId: 'thread-1', actionId: 'action-1' },
      perm: makeAllowedPerm('shopifyCustomers', ['read']),
    } as never);

    assert.equal(outcome.status, 'tool_error');
    assert.match(outcome.message ?? '', /durable run protection/);
    assert.equal(executed, false);
  });

  it('never persists protected arguments or results through the durable approval path', async () => {
    let executed = false;
    let approvalCheckCalled = false;
    const registry = new ToolRegistry();
    registry.register({
      id: asToolId('shopifyCustomers'),
      family: 'shopify',
      actionGroups: new Set(['read']),
      argsSchema: z.object({
        connectionId: z.string().uuid(),
        operation: z.literal('search_customers'),
        search: z.object({ field: z.literal('email'), value: z.string().email() }).strict(),
      }).strict(),
      resultSchema: z.object({ data: z.array(z.unknown()) }),
      description: 'Shopify customer test tool',
      parameterDocs: 'closed test contract',
      permissionCheck: () => ok('read'),
      execute: async () => {
        executed = true;
        return ok({ data: [] });
      },
    });
    const executor = new ToolExecutor({
      toolRegistry: registry,
      permissions: {} as never,
      connectionRegistry: {
        listAccessibleShopifyConnections: async () => ok([connection('Store A', connectionId)]),
      } as never,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    });

    const outcome = await executor.executeForRuntime({
      toolId: 'shopifyCustomers',
      args: {
        connectionId,
        operation: 'search_customers',
        search: { field: 'email', value: 'private@example.test' },
      },
      chatId: 'chat-1',
      approvalGate: {
        inspect: async () => ({
          kind: 'required',
          authority: 'connection_owner',
          approver: { userId: 'owner-1', displayName: 'Owner' },
          connectionScope: {
            connectionId,
            mode: 'connection_owner',
            policySource: 'manager_policy',
          },
        }),
        check: async () => {
          approvalCheckCalled = true;
          throw new Error('must not persist');
        },
      } as never,
      runContext: {
        companyId: 'company-1',
        userId: 'user-1',
        companyRole: 'MEMBER',
        channel: 'lark',
      },
      perm: makeAllowedPerm('shopifyCustomers', ['read']),
    } as never);

    assert.equal(outcome.status, 'approval_misconfigured');
    assert.match(outcome.message ?? '', /cannot be stored in a durable approval request/);
    assert.equal(approvalCheckCalled, false);
    assert.equal(executed, false);
  });
});

function buildExecutor(input: {
  connections: Array<ReturnType<typeof connection>>;
  execute?: Tool<{ connectionId: string; operation: 'sales_summary' }, { rows: number }>['execute'];
}) {
  const registry = new ToolRegistry();
  registry.register({
    id: asToolId('shopifyAnalytics'),
    family: 'shopify',
    actionGroups: new Set(['read']),
    argsSchema: z.object({
      connectionId: z.string().uuid(),
      operation: z.literal('sales_summary'),
    }).strict(),
    resultSchema: z.object({ rows: z.number() }),
    description: 'Shopify analytics test tool',
    parameterDocs: 'closed test contract',
    permissionCheck: (_args, permission) => permission.allowedActionsByTool
      .get(asToolId('shopifyAnalytics'))?.has('read')
      ? ok('read')
      : err(new PermissionError({ reason: 'not_allowed', toolId: 'shopifyAnalytics', action: 'read' })),
    execute: input.execute ?? (async () => ok({ rows: 1 })),
  });
  return new ToolExecutor({
    toolRegistry: registry,
    permissions: {} as never,
    connectionRegistry: {
      listAccessibleShopifyConnections: async () => ok(input.connections),
    } as never,
    shopifyDataRuns: { record: async () => undefined },
    logger: noopLogger,
    clock: { now: () => new Date(), nowMs: () => Date.now() },
  });
}

function shopifyConnectionRegistry() {
  return {
    listAccessibleShopifyConnections: async () => ok([connection('Store A', connectionId)]),
  } as never;
}

function runtimeInput(overrides: Record<string, unknown> = {}) {
  return {
    toolId: 'shopifyAnalytics',
    args: { connectionId, operation: 'sales_summary' },
    runContext: {
      companyId: 'company-1',
      userId: 'user-1',
      companyRole: 'MEMBER',
      channel: 'lark',
      traceId: 'runtime-run-1',
      chatId: 'runtime-thread-1',
    },
    perm: makeAllowedPerm('shopifyAnalytics', ['read']),
    ...overrides,
  } as never;
}

function connection(label: string, id: string) {
  return {
    connectionId: id,
    provider: 'shopify' as const,
    label,
    accountName: label,
    ownerType: 'user' as const,
    ownerUserId: 'user-1',
    access: 'read_only' as const,
    scopes: ['read_reports'],
    connectedAt: new Date('2026-08-02T12:00:00.000Z'),
  };
}
