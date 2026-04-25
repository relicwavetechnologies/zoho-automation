import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../../src/application/orchestration/engine/planner.ts';
import type { PlannerInput } from '../../src/application/orchestration/engine/planner.ts';
import { textModel, errorModel } from '../helpers/mock-model.ts';
import type { Logger } from '../../src/shared/logger.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const emptyInput = (): PlannerInput => ({
  userMessage: 'Send a message to Alice',
  history: { turns: [], truncated: false, tokenEstimate: 0 },
  availableTools: [],
  perm: {
    allowedToolIds: new Set() as any,
    allowedActionsByTool: new Map() as any,
    decisions: [],
  },
});

const validPlan = {
  planId: 'plan-001',
  intent: 'Send a message to Alice on Lark',
  steps: [
    {
      stepId: 'step-001',
      agentId: 'lark-ops-agent',
      objective: 'Send a direct message to Alice',
      toolIds: ['larkMessaging'],
      dependsOn: [],
      wave: 0,
    },
  ],
  synthesisHint: 'Confirm the message was sent',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Planner', () => {
  it('returns a valid Plan from clean JSON response', async () => {
    const planner = new Planner({ model: textModel(JSON.stringify(validPlan)), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.planId, 'plan-001');
    assert.equal(result.value.steps.length, 1);
    assert.equal(result.value.steps[0]!.stepId, 'step-001');
  });

  it('extracts JSON from markdown code fence', async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``;
    const planner = new Planner({ model: textModel(fenced), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.planId, 'plan-001');
  });

  it('extracts JSON from plain code fence (no language tag)', async () => {
    const fenced = `\`\`\`\n${JSON.stringify(validPlan)}\n\`\`\``;
    const planner = new Planner({ model: textModel(fenced), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.planId, 'plan-001');
  });

  it('returns OrchestrationError(llm_invalid_output) when JSON is malformed', async () => {
    const planner = new Planner({ model: textModel('not valid json {{{'), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'plan');
    assert.equal(result.error.payload.reason, 'llm_invalid_output');
  });

  it('returns OrchestrationError(llm_invalid_output) when schema validation fails', async () => {
    const badPlan = { planId: 123, steps: 'not-an-array' };
    const planner = new Planner({ model: textModel(JSON.stringify(badPlan)), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'plan');
    assert.equal(result.error.payload.reason, 'llm_invalid_output');
  });

  it('returns OrchestrationError when LLM throws', async () => {
    const planner = new Planner({ model: errorModel('network failure'), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.stage, 'plan');
    assert.match(result.error.message, /network failure/);
  });

  it('parses plan with multiple steps and waves', async () => {
    const multiPlan = {
      planId: 'plan-multi',
      intent: 'Do two things',
      steps: [
        { stepId: 'a', agentId: 'agent-a', objective: 'step A', toolIds: ['larkTask'], dependsOn: [], wave: 0 },
        { stepId: 'b', agentId: 'agent-b', objective: 'step B', toolIds: ['larkMessaging'], dependsOn: ['a'], wave: 1 },
      ],
    };
    const planner = new Planner({ model: textModel(JSON.stringify(multiPlan)), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.steps.length, 2);
    assert.equal(result.value.steps[1]!.wave, 1);
    assert.deepEqual(result.value.steps[1]!.dependsOn, ['a']);
  });

  it('accepts plan without synthesisHint (optional field)', async () => {
    const noHint = { planId: 'p', intent: 'test', steps: [] };
    const planner = new Planner({ model: textModel(JSON.stringify(noHint)), logger: noopLogger });
    const result = await planner.plan(emptyInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.synthesisHint, undefined);
  });

  it('includes department system prompt when provided', async () => {
    // We test that a plan is still returned even with dept context injected
    const planner = new Planner({ model: textModel(JSON.stringify(validPlan)), logger: noopLogger });
    const input = { ...emptyInput(), departmentSystemPrompt: 'Engineering team only' };
    const result = await planner.plan(input);
    assert.equal(result.ok, true);
  });
});
