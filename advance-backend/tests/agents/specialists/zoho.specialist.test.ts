/**
 * ZohoSpecialist — standalone tests.
 *
 * Verifies tool filtering (zohoCrm + zohoBooks only),
 * DelegationResult fields, and error propagation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoSpecialist } from '../../../src/application/orchestration/agents/specialists/zoho.specialist.ts';
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

const ZOHO_TOOL_IDS   = ['zohoCrm', 'zohoBooks'];
const OTHER_TOOL_IDS  = ['larkTask', 'googleGmail', 'contextSearch'];
const ALL_TOOL_IDS    = [...ZOHO_TOOL_IDS, ...OTHER_TOOL_IDS];

// ─── Tool filtering ───────────────────────────────────────────────────────────

describe('ZohoSpecialist — tool filtering', () => {
  it('passes only zoho-family tools to the planner', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createZohoSpecialist({
      planner:  mockPlanner(makePlan(['zohoCrm']), ids => { capturedToolIds = ids; }),
      executor: mockExecutor({ stepStatus: 'success', toolId: 'zohoCrm' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ALL_TOOL_IDS));
    assert.equal(result.ok, true);

    const nonZoho = capturedToolIds.filter(id => !ZOHO_TOOL_IDS.includes(id));
    assert.equal(nonZoho.length, 0, `Non-zoho tools leaked: ${nonZoho.join(', ')}`);
    for (const id of ZOHO_TOOL_IDS) {
      assert.ok(capturedToolIds.includes(id), `Missing zoho tool: ${id}`);
    }
  });

  it('falls back to all permitted tools when no zoho tools available', async () => {
    let capturedToolIds: string[] = [];

    const specialist = createZohoSpecialist({
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

describe('ZohoSpecialist — DelegationResult', () => {
  it("confidence='high' when CRM step succeeds", async () => {
    const specialist = createZohoSpecialist({
      planner:  mockPlanner(makePlan(['zohoCrm'])),
      executor: mockExecutor({ stepStatus: 'success', toolStatus: 'success', toolId: 'zohoCrm' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ZOHO_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
    assert.equal(result.value.domain, 'zoho');
    assert.deepEqual(result.value.failedToolIds, []);
  });

  it("confidence='none' when books step fails", async () => {
    const specialist = createZohoSpecialist({
      planner:  mockPlanner(makePlan(['zohoBooks'])),
      executor: mockExecutor({ stepStatus: 'failed', toolStatus: 'failed', toolId: 'zohoBooks' }),
      logger:   noopLogger,
    });

    const result = await specialist.run(makeSpecialistInput(ZOHO_TOOL_IDS));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'none');
    assert.ok(result.value.failedToolIds.includes('zohoBooks'));
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('ZohoSpecialist — error propagation', () => {
  it('propagates planner failure', async () => {
    const specialist = createZohoSpecialist({
      planner:  failingPlanner(),
      executor: mockExecutor({ stepStatus: 'success' }),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(ZOHO_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'plan');
  });

  it('propagates executor failure', async () => {
    const specialist = createZohoSpecialist({
      planner:  mockPlanner(makePlan(['zohoCrm'])),
      executor: failingExecutor(),
      logger:   noopLogger,
    });
    const result = await specialist.run(makeSpecialistInput(ZOHO_TOOL_IDS));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'execute');
  });
});
