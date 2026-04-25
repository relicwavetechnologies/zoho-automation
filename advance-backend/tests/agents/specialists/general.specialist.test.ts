/**
 * GeneralSpecialist — standalone tests.
 *
 * The general specialist is the fallback — it receives ALL permitted tools
 * and lets the planner decide what to use.
 *
 * Key properties:
 *   - ownedToolIds = [] (empty) → always passes all permitted tools to planner
 *   - agentDef.toolIds whitelist is still respected if admin configures one
 *   - Same DelegationResult contract as domain specialists
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralSpecialist } from '../../../src/application/orchestration/agents/specialists/general.specialist.ts';
import {
  noopLogger,
  makePlan,
  mockPlanner,
  failingPlanner,
  mockExecutor,
  failingExecutor,
  makeSpecialistInput,
} from '../../helpers/agent-mocks.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_TOOL_IDS = ['larkTask', 'larkMessaging', 'googleGmail', 'googleDrive', 'zohoCrm', 'contextSearch'];

// ─── Tool filtering ───────────────────────────────────────────────────────────

describe('GeneralSpecialist — tool filtering', () => {
  it('passes ALL permitted tools to the planner', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan(['larkTask']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);

    // All tools should be presented — general specialist doesn't filter
    for (const id of ALL_TOOL_IDS) {
      assert.ok(capturedToolIds.includes(id), `Tool missing from general planner: ${id}`);
    }
  });

  it('passes empty tool set to planner when no tools permitted', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan([]), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput([]));
    assert.equal(result.ok, true);
    assert.equal(capturedToolIds.length, 0);
  });

  it('respects agentDef.toolIds whitelist even on the general specialist', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan(['larkTask']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const input = makeSpecialistInput(ALL_TOOL_IDS);
    input.agentDef = {
      id:           'agent-general',
      name:         'General Agent',
      systemPrompt: null,
      toolIds:      ['larkTask', 'googleGmail'],  // admin whitelist
    };

    const result = await specialist.run(input);
    assert.equal(result.ok, true);

    // Only whitelisted tools should reach the planner
    assert.ok(capturedToolIds.includes('larkTask'));
    assert.ok(capturedToolIds.includes('googleGmail'));
    const unexpected = capturedToolIds.filter(id => !['larkTask', 'googleGmail'].includes(id));
    assert.equal(unexpected.length, 0, `Unexpected tools: ${unexpected.join(', ')}`);
  });
});

// ─── DelegationResult ─────────────────────────────────────────────────────────

describe('GeneralSpecialist — DelegationResult', () => {
  it("confidence='high' when any step succeeds", async () => {
    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: mockExecutor({ stepStatus: 'success', toolStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
    assert.equal(result.value.domain, 'general');
    assert.deepEqual(result.value.failedToolIds, []);
  });

  it("confidence='none' when all steps fail", async () => {
    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'failed', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'none');
    assert.ok(result.value.failedToolIds.includes('larkTask'));
  });

  it("has no missingToolIds when plan uses tools from the all-tools set", async () => {
    const plan = makePlan(['larkTask', 'googleGmail', 'zohoCrm']);

    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(plan),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const missing = result.value.missingToolIds ?? [];
    assert.equal(missing.length, 0);
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('GeneralSpecialist — error propagation', () => {
  it('propagates planner failure', async () => {
    const specialist = createGeneralSpecialist({
      planner:  failingPlanner(),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, false);
  });

  it('propagates executor failure', async () => {
    const specialist = createGeneralSpecialist({
      planner:  mockPlanner(makePlan(['larkTask'])),
      executor: failingExecutor(),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'execute');
  });
});
