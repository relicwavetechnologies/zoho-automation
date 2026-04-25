/**
 * LarkSpecialist — standalone tests.
 *
 * Each test invokes specialist.run() directly with mocked planner + executor.
 * No real DB, Redis, or LLM is required.
 *
 * Verifies:
 *   1. Tool filtering: only larkTask/larkMessaging/etc. passed to planner
 *   2. DelegationResult confidence derivation (high / partial / none)
 *   3. failedToolIds populated from failed outcomes
 *   4. missingToolIds populated when plan references out-of-scope tools
 *   5. Falls back to all-tools when scoped set is empty
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLarkSpecialist } from '../../../src/application/orchestration/agents/specialists/lark.specialist.ts';
import {
  noopLogger,
  makeTool,
  makePlan,
  mockPlanner,
  failingPlanner,
  mockExecutor,
  failingExecutor,
  makeSpecialistInput,
} from '../../helpers/agent-mocks.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LARK_TOOL_IDS = ['larkTask', 'larkMessaging', 'larkCalendar', 'larkDoc', 'larkBase', 'larkApproval'];
const OTHER_TOOL_IDS = ['googleGmail', 'googleDrive', 'zohoCrm'];

// ─── Tool filtering ───────────────────────────────────────────────────────────

describe('LarkSpecialist — tool filtering', () => {
  it('passes only lark-family tools to the planner when mixed tools are available', async () => {
    const allToolIds = [...LARK_TOOL_IDS, ...OTHER_TOOL_IDS];
    let capturedToolIds: string[] = [];

    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(allToolIds));

    assert.equal(result.ok, true);
    // Only lark tools should have been presented to the planner
    const nonLark = capturedToolIds.filter(id => !LARK_TOOL_IDS.includes(id));
    assert.equal(nonLark.length, 0, `Non-lark tools leaked into planner: ${nonLark.join(', ')}`);
    // All enabled lark tools should be there
    for (const id of LARK_TOOL_IDS) {
      assert.ok(capturedToolIds.includes(id), `Missing lark tool: ${id}`);
    }
  });

  it('uses all permitted tools when no lark tools are available (graceful fallback)', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['googleGmail']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'googleGmail' }),
      logger:   noopLogger,
    });

    // Only provide non-lark tools
    const result = await specialist.run(makeSpecialistInput(OTHER_TOOL_IDS));

    assert.equal(result.ok, true);
    // Fallback: all permitted tools should be passed
    assert.ok(capturedToolIds.includes('googleGmail'));
  });

  it('respects agentDef.toolIds when admin has configured a whitelist', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const input = makeSpecialistInput(LARK_TOOL_IDS);
    // Admin configured only larkTask + larkMessaging for this agent
    input.agentDef = {
      id:           'agent-1',
      name:         'Lark Task Agent',
      systemPrompt: null,
      toolIds:      ['larkTask', 'larkMessaging'],
    };

    const result = await specialist.run(input);
    assert.equal(result.ok, true);

    // Planner should only see the admin-whitelisted tools
    assert.ok(capturedToolIds.includes('larkTask'));
    assert.ok(capturedToolIds.includes('larkMessaging'));
    const nonWhitelisted = capturedToolIds.filter(id => !['larkTask', 'larkMessaging'].includes(id));
    assert.equal(nonWhitelisted.length, 0);
  });
});

// ─── DelegationResult — confidence ────────────────────────────────────────────

describe('LarkSpecialist — DelegationResult confidence', () => {
  it("returns confidence='high' when all steps succeed", async () => {
    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: mockExecutor({ stepStatus: 'success', toolStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
    assert.deepEqual(result.value.failedToolIds, []);
  });

  it("returns confidence='none' when all steps fail", async () => {
    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'failed', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'none');
    assert.ok(result.value.failedToolIds.includes('larkTask'));
  });

  it("includes permission_denied tools in failedToolIds", async () => {
    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkMessaging'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'permission_denied', toolId: 'larkMessaging' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.failedToolIds.includes('larkMessaging'));
  });
});

// ─── DelegationResult — missingToolIds ────────────────────────────────────────

describe('LarkSpecialist — DelegationResult missingToolIds', () => {
  it('reports missingToolIds when plan references a tool outside the lark scope', async () => {
    // Plan that references googleGmail (not a lark tool)
    const plan = makePlan(['larkTask', 'googleGmail']);

    const specialist = createLarkSpecialist({
      planner:  mockPlanner(plan),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.missingToolIds?.includes('googleGmail'));
  });

  it('has no missingToolIds when plan only references lark tools', async () => {
    const plan = makePlan(['larkTask', 'larkMessaging']);

    const specialist = createLarkSpecialist({
      planner:  mockPlanner(plan),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const missing = result.value.missingToolIds ?? [];
    assert.equal(missing.length, 0);
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('LarkSpecialist — error propagation', () => {
  it('propagates planner failure as Result.err', async () => {
    const specialist = createLarkSpecialist({
      planner:  failingPlanner(),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, 'orchestration');
    assert.equal(result.error.payload.stage, 'plan');
  });

  it('propagates executor failure as Result.err', async () => {
    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: failingExecutor(),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, 'orchestration');
    assert.equal(result.error.payload.stage, 'execute');
  });

  it('always returns the correct domain', async () => {
    const specialist = createLarkSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(LARK_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.domain, 'lark');
  });
});
