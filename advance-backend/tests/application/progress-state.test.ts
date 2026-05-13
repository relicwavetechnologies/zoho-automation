import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProgressState,
  addPlanStep,
  markStepDone,
  markStepFailed,
  setPhase,
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
      assert.equal(timeline.liveLabel, 'Routing…');
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
      assert.ok(timeline.liveLabel!.includes('1/2'));
    });

    it('shows phase label in liveLabel', () => {
      const state = createProgressState();
      setPhase(state, 'synthesizing');
      addPlanStep(state, 'zohoAgent');
      markStepDone(state, 'zohoAgent', 'ok');

      const timeline = toTimeline(state);
      assert.ok(timeline.liveLabel!.includes('Preparing response…'));
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
