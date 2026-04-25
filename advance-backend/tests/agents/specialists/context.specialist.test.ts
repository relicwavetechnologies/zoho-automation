/**
 * ContextSpecialist — standalone tests.
 *
 * Verifies tool filtering (contextSearch + webSearch only),
 * DelegationResult fields, and error propagation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContextSpecialist } from '../../../src/application/orchestration/agents/specialists/context.specialist.ts';
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

const CONTEXT_TOOL_IDS = ['contextSearch', 'webSearch'];
const OTHER_TOOL_IDS   = ['larkTask', 'googleGmail', 'zohoCrm'];
const ALL_TOOL_IDS     = [...CONTEXT_TOOL_IDS, ...OTHER_TOOL_IDS];

// ─── Tool filtering ───────────────────────────────────────────────────────────

describe('ContextSpecialist — tool filtering', () => {
  it('passes only context-family tools to the planner', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['contextSearch']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'contextSearch' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);

    const nonContext = capturedToolIds.filter(id => !CONTEXT_TOOL_IDS.includes(id));
    assert.equal(nonContext.length, 0, `Non-context tools leaked: ${nonContext.join(', ')}`);
    for (const id of CONTEXT_TOOL_IDS) {
      assert.ok(capturedToolIds.includes(id), `Missing context tool: ${id}`);
    }
  });

  it('falls back to all permitted tools when no context tools available', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['larkTask']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'larkTask' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(OTHER_TOOL_IDS));
    assert.equal(result.ok, true);
    assert.ok(capturedToolIds.length > 0);
  });
});

// ─── DelegationResult ─────────────────────────────────────────────────────────

describe('ContextSpecialist — DelegationResult', () => {
  it("confidence='high' on successful search", async () => {
    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['contextSearch'])),
      executor: mockExecutor({ stepStatus: 'success', toolStatus: 'success', toolId: 'contextSearch' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(CONTEXT_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
    assert.equal(result.value.domain, 'context');
    assert.deepEqual(result.value.failedToolIds, []);
  });

  it("confidence='none' when search step fails", async () => {
    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['webSearch'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'failed', toolId: 'webSearch' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(CONTEXT_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'none');
    assert.ok(result.value.failedToolIds.includes('webSearch'));
  });

  it('both contextSearch and webSearch can be used in one plan', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['contextSearch', 'webSearch']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'contextSearch' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(CONTEXT_TOOL_IDS));
    assert.equal(result.ok, true);
    assert.ok(capturedToolIds.includes('contextSearch'));
    assert.ok(capturedToolIds.includes('webSearch'));
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('ContextSpecialist — error propagation', () => {
  it('propagates planner failure', async () => {
    const specialist = createContextSpecialist({
      planner:  failingPlanner(),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(CONTEXT_TOOL_IDS));
    assert.equal(result.ok, false);
  });

  it('propagates executor failure', async () => {
    const specialist = createContextSpecialist({
      planner:  mockPlanner(makePlan(['contextSearch'])),
      executor: failingExecutor(),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(CONTEXT_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'execute');
  });
});
