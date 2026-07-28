import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProgressState,
  addPlanStep,
  markStepDone,
  markStepFailed,
  setPhase,
  setDeclaredTodos,
  toTimeline,
  renderExecutionTrace,
} from '../../src/application/orchestration/engine/progress-state.ts';

describe('ProgressState', () => {
  describe('createProgressState()', () => {
    it('initializes with routing phase and empty steps', () => {
      const state = createProgressState();
      assert.equal(state.phase, 'routing');
      assert.equal(state.steps.length, 0);
      assert.equal(state.totalSteps, 0);
      assert.equal(state.completedSteps, 0);
      assert.ok(state.startedAt > 0);
    });
  });

  describe('addPlanStep()', () => {
    it('adds a step with running status and sets phase to executing', () => {
      const state = createProgressState();
      const stepId = addPlanStep(state, 'zohoAgent');
      assert.equal(stepId, 'step_1');
      assert.equal(state.steps.length, 1);
      assert.equal(state.totalSteps, 1);
      assert.equal(state.phase, 'executing');
      assert.equal(state.steps[0]!.status, 'running');
      assert.equal(state.steps[0]!.agentSlug, 'zohoAgent');
      assert.equal(state.steps[0]!.label, 'Reading Zoho');
    });

    it('assigns sequential step IDs', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      addPlanStep(state, 'larkAgent');
      assert.equal(state.steps[0]!.stepId, 'step_1');
      assert.equal(state.steps[1]!.stepId, 'step_2');
      assert.equal(state.totalSteps, 2);
    });

    it('uses fallback labels for unknown tools', () => {
      const state = createProgressState();
      addPlanStep(state, 'agent_my_custom_agent');
      assert.equal(state.steps[0]!.label, 'Working');
    });
  });

  describe('markStepDone()', () => {
    it('marks a running step as done with preview', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Found 23 invoices');
      assert.equal(state.steps[0]!.status, 'done');
      assert.equal(state.steps[0]!.resultSummary, 'Found 23 invoices');
      assert.equal(state.completedSteps, 1);
      assert.ok(state.steps[0]!.completedAt! > 0);
    });

    it('does nothing if no running step matches', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'larkAgent', 'done');
      assert.equal(state.steps[0]!.status, 'running');
      assert.equal(state.completedSteps, 0);
    });
  });

  describe('markStepFailed()', () => {
    it('marks step as failed with truncated error', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepFailed(state, 'zohoAgent', 'Connection timeout');
      assert.equal(state.steps[0]!.status, 'failed');
      assert.equal(state.steps[0]!.error, 'Connection timeout');
    });

    it('truncates long error messages', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      const longError = 'x'.repeat(200);
      markStepFailed(state, 'zohoAgent', longError);
      assert.ok(state.steps[0]!.error!.length <= 103);
      assert.ok(state.steps[0]!.error!.endsWith('...'));
    });
  });

  describe('toTimeline()', () => {
    it('returns liveLabel only when no steps', () => {
      const state = createProgressState();
      const timeline = toTimeline(state);
      assert.equal(timeline.liveLabel, 'Thinking…');
      assert.equal(timeline.phase, 'Thinking');
      assert.equal(timeline.progressPct, 8);
      assert.equal(timeline.plan, undefined);
    });

    it('returns plan items with correct statuses', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      addPlanStep(state, 'larkAgent');
      markStepDone(state, 'zohoAgent', '5 results');

      const timeline = toTimeline(state);
      assert.ok(timeline.plan);
      assert.equal(timeline.plan.length, 2);
      assert.equal(timeline.plan[0]!.status, 'done');
      assert.equal(timeline.plan[1]!.status, 'running');
      assert.equal(timeline.phase, 'Executing · 2 actions');
      assert.equal(timeline.plan[0]!.toolFamily, 'zoho');
      assert.equal(timeline.plan[0]!.subtitle, '5 results');
    });

    it('shows phase label in liveLabel', () => {
      const state = createProgressState();
      setPhase(state, 'synthesizing');
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'ok');

      const timeline = toTimeline(state);
      assert.ok(timeline.liveLabel!.includes('Preparing response…'));
    });

    // The run cannot know how many calls it will need, so counting calls into a
    // total produced "Step 11/11" — a fraction that could never read otherwise.
    it('never emits a denominator derived from the call count', () => {
      const state = createProgressState();
      for (const tool of ['zohoAgent', 'larkAgent', 'zohoAgent']) {
        addPlanStep(state, tool);
        markStepDone(state, tool, 'ok');
      }

      const timeline = toTimeline(state);
      assert.equal(timeline.declared, undefined);
      assert.equal(timeline.actionCount, 3);
      assert.doesNotMatch(timeline.phase!, /3\/3/);
    });

    it('emits a fraction only from a declared checklist', () => {
      const state = createProgressState();
      addPlanStep(state, 'manageTodos');
      markStepDone(state, 'manageTodos', 'ok');
      setDeclaredTodos(state, [
        { title: 'Pull invoices',  status: 'done' },
        { title: 'Match payments', status: 'in_progress' },
        { title: 'File report',    status: 'pending' },
      ]);

      const timeline = toTimeline(state);
      assert.deepEqual(timeline.declared, {
        done: 1, total: 3, current: 'Match payments', next: 'File report',
      });
      assert.equal(timeline.phase, 'Executing · 2/3');
    });

    it('drops a checklist once every item is cancelled', () => {
      const state = createProgressState();
      setDeclaredTodos(state, [{ title: 'Abandoned', status: 'cancelled' }]);
      assert.equal(toTimeline(state).declared, undefined);
    });

    it('publishes the run start so renderers can tick elapsed themselves', () => {
      const state = createProgressState();
      assert.equal(toTimeline(state).startedAtMs, state.startedAt);
    });
  });

  describe('ledger', () => {
    it('collapses consecutive calls to one tool family into a single row', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Matched customer');
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Created INV-1043');
      addPlanStep(state, 'larkAgent');
      markStepDone(state, 'larkAgent', 'Task created');

      const rows = toTimeline(state).ledger!;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.label, 'Zoho');
      assert.equal(rows[0]!.count, 2);
      assert.equal(rows[0]!.outcome, 'Created INV-1043', 'keeps the newest outcome');
      assert.equal(rows[1]!.label, 'Lark');
      assert.equal(rows[1]!.count, 1);
    });

    it('keeps a running step out of the group above it', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Matched customer');
      addPlanStep(state, 'zohoAgent');

      const rows = toTimeline(state).ledger!;
      assert.equal(rows.length, 2);
      assert.equal(rows[1]!.status, 'running');
    });

    it('marks a group failed when any call in it failed', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Matched customer');
      addPlanStep(state, 'zohoAgent');
      markStepFailed(state, 'zohoAgent', '401 — token expired');

      const rows = toTimeline(state).ledger!;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'failed');
      assert.equal(rows[0]!.outcome, '401 — token expired');
    });

    // A retry after a 429 used to render "✗ Zoho · 2 calls — Created INV-1043":
    // the marker described the first call, the outcome the second.
    it('lets a successful retry clear the failure marker it follows', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      markStepFailed(state, 'zohoAgent', '429 rate limited');
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'Created INV-1043');

      const rows = toTimeline(state).ledger!;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.count, 2);
      assert.equal(rows[0]!.status, 'done');
      assert.equal(rows[0]!.outcome, 'Created INV-1043');
    });

    // manageTodos returns its confirmation plus the whole checklist so the model
    // sees current state; the ids and [pending] markers are not for users.
    it('keeps the checklist dump out of every user-facing summary', () => {
      const state = createProgressState();
      addPlanStep(state, 'manageTodos');
      markStepDone(
        state,
        'manageTodos',
        'Updated "Pull invoices" → done\n[done] 1. Pull invoices (id:c1)\n[pending] 2. Reconcile (id:c2)',
      );

      const timeline = toTimeline(state);
      for (const text of [
        timeline.ledger![0]!.outcome,
        timeline.plan![0]!.subtitle!,
        renderExecutionTrace(state),
      ]) {
        assert.doesNotMatch(text, /\(id:/);
        assert.doesNotMatch(text, /\[(pending|done|in_progress)\]/);
      }
    });
  });

  describe('renderExecutionTrace()', () => {
    it('returns empty string when no steps', () => {
      const state = createProgressState();
      assert.equal(renderExecutionTrace(state), '');
    });

    it('renders trace with step markers', () => {
      const state = createProgressState();
      addPlanStep(state, 'zohoAgent');
      addPlanStep(state, 'larkAgent');
      markStepDone(state, 'zohoAgent', '23 invoices');
      markStepFailed(state, 'larkAgent', 'timeout');

      const trace = renderExecutionTrace(state);
      assert.ok(trace.includes('---'));
      assert.ok(trace.includes('**Trace**'));
      assert.ok(trace.includes('2 steps'));
      assert.ok(trace.includes('✓'));
      assert.ok(trace.includes('✗'));
      assert.ok(trace.includes('23 invoices'));
      assert.ok(trace.includes('timeout'));
    });

    it('uses completed outcome labels for Lark task creation', () => {
      const state = createProgressState();
      addPlanStep(state, 'agent_lark_ops');
      markStepDone(state, 'agent_lark_ops', 'Task "Develop HTML skills" has been created.');

      const trace = renderExecutionTrace(state);
      assert.ok(trace.includes('✓ Created Lark task — Develop HTML skills'));
      assert.equal(trace.includes('Updating Lark'), false);
    });

    it('caps final trace rows while preserving total step count', () => {
      const state = createProgressState();
      for (let i = 1; i <= 7; i++) {
        addPlanStep(state, 'zohoAgent');
        markStepDone(state, 'zohoAgent', `result ${i}`);
      }

      const trace = renderExecutionTrace(state);
      assert.ok(trace.includes('7 steps'));
      assert.ok(trace.includes('showing last 5'));
      assert.equal(trace.split('\n').filter(line => line.startsWith('✓')).length, 5);
      assert.equal(trace.includes('result 1'), false);
      assert.ok(trace.includes('result 7'));
    });
  });
});
