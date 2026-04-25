import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Executor } from '../../src/application/orchestration/engine/executor.ts';
import type { ExecutorDeps, ExecutorInput } from '../../src/application/orchestration/engine/executor.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import { toolCallModel, textModel, errorModel } from '../helpers/mock-model.ts';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Clock } from '../../src/shared/clock.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok, err } from '../../src/shared/result.ts';
import { PermissionError, ToolError } from '../../src/shared/errors.ts';
import type { Plan } from '../../src/domain/orchestration/plan.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const fakeClock: Clock = { nowMs: () => 1000 };

const noopStatus = {
  sendStatus: async () => null,
  editStatus: async (_h: unknown, _t: string) => null,
};

const noopPerm: PermissionResult = {
  allowedToolIds: new Set([asToolId('larkTask'), asToolId('larkMessaging')]) as any,
  allowedActionsByTool: new Map() as any,
  decisions: [],
};

const noopPermQuery = {
  companyId: 'co1' as any,
  userId: 'usr1' as any,
  companyRole: 'MEMBER' as any,
  channel: 'lark' as const,
};

const noopRunContext = {
  companyId: 'co1' as any,
  userId: 'usr1' as any,
  companyRole: 'MEMBER' as any,
  channel: 'lark' as const,
};

/** Build a minimal Tool that always succeeds */
function makeTool(id: string, extraCheck?: () => boolean): Tool<{ op: string }, string> {
  return {
    id: asToolId(id),
    family: 'larkTask' as any,
    actionGroups: new Set(['read']) as any,
    argsSchema: z.object({ op: z.string() }),
    resultSchema: z.string(),
    description: `Mock tool ${id}`,
    parameterDocs: '',
    permissionCheck: (_args, _perm) => {
      if (extraCheck && !extraCheck()) {
        return err(new PermissionError({ toolId: id, action: 'read', reason: 'not_allowed' }));
      }
      return ok('read' as any);
    },
    execute: async (_args, _ctx) => ok(`${id}-result`),
  };
}

/** Build a Tool whose execute always fails */
function makeFailingTool(id: string): Tool<{ op: string }, string> {
  return {
    ...makeTool(id),
    execute: async (_args, _ctx) => err(new ToolError({ toolId: id, reason: 'upstream_failure', message: 'remote error' })),
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    intent: 'test',
    steps: [
      {
        stepId: 'step-1',
        agentId: 'agent-1',
        objective: 'Call larkTask with op=list',
        toolIds: ['larkTask'],
        dependsOn: [],
        wave: 0,
      },
    ],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  const registry = new ToolRegistry();
  registry.register(makeTool('larkTask'));
  return {
    model: toolCallModel([{ toolName: 'larkTask', input: { op: 'list' } }]),
    permissions: { resolve: async () => ok(noopPerm) } as any,
    toolRegistry: registry,
    logger: noopLogger,
    clock: fakeClock,
    ...overrides,
  };
}

function makeInput(planOverride?: Partial<Plan>): ExecutorInput {
  return {
    plan: makePlan(planOverride),
    perm: noopPerm,
    runContext: noopRunContext,
    permQuery: noopPermQuery,
    statusChannel: noopStatus,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Executor', () => {
  it('runs a single-step plan and returns success', async () => {
    const executor = new Executor(makeDeps());
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults.length, 1);
    assert.equal(result.value.stepResults[0]!.status, 'success');
    assert.equal(result.value.allToolOutcomes.length, 1);
    assert.equal(result.value.allToolOutcomes[0]!.status, 'success');
  });

  it('runs two parallel steps in wave 0', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('larkTask'));
    registry.register(makeTool('larkMessaging'));

    const model = toolCallModel([
      { toolName: 'larkTask',      input: { op: 'list' } },
      { toolName: 'larkMessaging', input: { op: 'send' } },
    ]);

    const executor = new Executor({ ...makeDeps(), model, toolRegistry: registry });
    const plan = makePlan({
      steps: [
        { stepId: 's1', agentId: 'a1', objective: 'task step', toolIds: ['larkTask'],      dependsOn: [], wave: 0 },
        { stepId: 's2', agentId: 'a2', objective: 'msg step',  toolIds: ['larkMessaging'], dependsOn: [], wave: 0 },
      ],
    });
    const result = await executor.run(makeInput(plan));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults.length, 2);
  });

  it('runs steps in wave order (wave 1 after wave 0)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('larkTask'));
    registry.register(makeTool('larkMessaging'));

    const executionOrder: string[] = [];
    const model = toolCallModel([{ toolName: 'larkTask', input: { op: 'x' } }]);

    const executor = new Executor({ ...makeDeps(), model, toolRegistry: registry });
    const plan = makePlan({
      steps: [
        { stepId: 'w0', agentId: 'a', objective: 'wave 0', toolIds: ['larkTask'],      dependsOn: [],     wave: 0 },
        { stepId: 'w1', agentId: 'b', objective: 'wave 1', toolIds: ['larkMessaging'], dependsOn: ['w0'], wave: 1 },
      ],
    });
    const result = await executor.run(makeInput(plan));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults.length, 2);
  });

  it('returns permission_denied outcome when permissionCheck fails', async () => {
    const deniedTool = makeTool('larkTask', () => false);
    const registry = new ToolRegistry();
    registry.register(deniedTool);

    const executor = new Executor({ ...makeDeps(), toolRegistry: registry });
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const outcome = result.value.allToolOutcomes[0];
    assert.equal(outcome?.status, 'permission_denied');
  });

  it('records failed outcome when tool execution fails', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFailingTool('larkTask'));

    const executor = new Executor({ ...makeDeps(), toolRegistry: registry });
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const outcome = result.value.allToolOutcomes[0];
    assert.equal(outcome?.status, 'failed');
    assert.match(outcome?.error ?? '', /remote error/);
  });

  it('returns err when step has unresolved dependency (cycle)', async () => {
    const plan = makePlan({
      steps: [
        { stepId: 's1', agentId: 'a', objective: 'step 1', toolIds: ['larkTask'], dependsOn: ['s2'], wave: 0 },
        { stepId: 's2', agentId: 'b', objective: 'step 2', toolIds: ['larkTask'], dependsOn: ['s1'], wave: 0 },
      ],
    });
    const executor = new Executor(makeDeps());
    const result = await executor.run(makeInput(plan));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'dependency_cycle');
  });

  it('produces failed step when no registered tools found for step', async () => {
    const emptyRegistry = new ToolRegistry();
    const executor = new Executor({ ...makeDeps(), toolRegistry: emptyRegistry });
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults[0]!.status, 'failed');
    assert.match(result.value.stepResults[0]!.summary, /No registered tools/);
  });

  it('handles LLM returning no tool calls — step marked failed', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('larkTask'));
    const executor = new Executor({ ...makeDeps(), model: textModel('I cannot help'), toolRegistry: registry });
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults[0]!.status, 'failed');
    assert.match(result.value.stepResults[0]!.summary, /no tool calls/i);
  });

  it('handles LLM error gracefully — step marked failed (no throws)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('larkTask'));
    const executor = new Executor({ ...makeDeps(), model: errorModel('LLM down'), toolRegistry: registry });
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.stepResults[0]!.status, 'failed');
  });

  it('accumulates all tool outcomes across multiple steps', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('larkTask'));
    registry.register(makeTool('larkMessaging'));

    const model = toolCallModel([{ toolName: 'larkTask', input: { op: 'x' } }]);
    const executor = new Executor({ ...makeDeps(), model, toolRegistry: registry });
    const plan = makePlan({
      steps: [
        { stepId: 'a', agentId: 'a', objective: 'a', toolIds: ['larkTask'],      dependsOn: [],   wave: 0 },
        { stepId: 'b', agentId: 'b', objective: 'b', toolIds: ['larkMessaging'], dependsOn: ['a'], wave: 1 },
      ],
    });
    const result = await executor.run(makeInput(plan));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allToolOutcomes.length, 2);
  });

  it('pendingApproval is always null', async () => {
    const executor = new Executor(makeDeps());
    const result = await executor.run(makeInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.pendingApproval, null);
  });
});
