/**
 * GoogleSpecialist — standalone tests.
 *
 * Verifies tool filtering (only google* tools pass to planner),
 * DelegationResult confidence, and error propagation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleSpecialist } from '../../../src/application/orchestration/agents/specialists/google.specialist.ts';
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

const GOOGLE_TOOL_IDS = ['googleGmail', 'googleDrive', 'googleCalendar'];
const OTHER_TOOL_IDS  = ['larkTask', 'larkMessaging', 'zohoCrm', 'zohoBooks'];
const ALL_TOOL_IDS    = [...GOOGLE_TOOL_IDS, ...OTHER_TOOL_IDS];

// ─── Tool filtering ───────────────────────────────────────────────────────────

describe('GoogleSpecialist — tool filtering', () => {
  it('passes only google-family tools to the planner', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createGoogleSpecialist({
      planner:  mockPlanner(makePlan(['googleGmail']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'googleGmail' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);

    const nonGoogle = capturedToolIds.filter(id => !GOOGLE_TOOL_IDS.includes(id));
    assert.equal(nonGoogle.length, 0, `Non-google tools leaked: ${nonGoogle.join(', ')}`);
    for (const id of GOOGLE_TOOL_IDS) {
      assert.ok(capturedToolIds.includes(id), `Missing google tool: ${id}`);
    }
  });

  it('falls back to all permitted tools when no google tools are available', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createGoogleSpecialist({
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

describe('GoogleSpecialist — DelegationResult', () => {
  it("confidence='high' when gmail step succeeds", async () => {
    const specialist = createGoogleSpecialist({
      planner:  mockPlanner(makePlan(['googleGmail'])),
      executor: mockExecutor({ stepStatus: 'success', toolStatus: 'success', toolId: 'googleGmail' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(GOOGLE_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
    assert.equal(result.value.domain, 'google');
    assert.deepEqual(result.value.failedToolIds, []);
  });

  it("confidence='none' when google step fails", async () => {
    const specialist = createGoogleSpecialist({
      planner:  mockPlanner(makePlan(['googleGmail'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'failed', toolId: 'googleGmail' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(GOOGLE_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'none');
    assert.ok(result.value.failedToolIds.includes('googleGmail'));
  });

  it('reports missingToolIds for lark tools referenced in plan', async () => {
    // If planner (mis)routes and references a lark tool
    const plan = makePlan(['googleGmail', 'larkTask']);

    const specialist = createGoogleSpecialist({
      planner:  mockPlanner(plan),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'googleGmail' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(GOOGLE_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.missingToolIds?.includes('larkTask'));
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('GoogleSpecialist — error propagation', () => {
  it('propagates planner failure', async () => {
    const specialist = createGoogleSpecialist({
      planner:  failingPlanner(),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(GOOGLE_TOOL_IDS));
    assert.equal(result.ok, false);
  });

  it('propagates executor failure', async () => {
    const specialist = createGoogleSpecialist({
      planner:  mockPlanner(makePlan(['googleGmail'])),
      executor: failingExecutor(),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(GOOGLE_TOOL_IDS));
    assert.equal(result.ok, false);
  });
});
