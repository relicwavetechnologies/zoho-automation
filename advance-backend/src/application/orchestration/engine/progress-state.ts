/**
 * Progress state tracking for the Lark bubble UX.
 *
 * Tracks plan steps (agent delegations / tool calls) through their lifecycle
 * and converts to ChannelTimeline for rendering via buildStatusCard().
 * Also renders an execution trace markdown block for the final card.
 */

import type { ChannelTimeline } from '../../../domain/channel/outbound';
import { getToolLabels } from '../agents/tool-labels';
import { previewToolResult } from '../agents/tool-result-preview';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProgressPhase =
  | 'routing'
  | 'planning'
  | 'executing'
  | 'synthesizing'
  | 'done'
  | 'failed';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ProgressStep {
  stepId:          string;
  label:           string;
  doneLabel:       string;
  status:          StepStatus;
  agentSlug:       string;
  toolActivity?:   string;
  resultSummary?:  string;
  error?:          string;
  startedAt?:      number;
  completedAt?:    number;
}

export interface ProgressState {
  phase:          ProgressPhase;
  steps:          ProgressStep[];
  totalSteps:     number;
  completedSteps: number;
  startedAt:      number;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createProgressState(): ProgressState {
  return {
    phase:          'routing',
    steps:          [],
    totalSteps:     0,
    completedSteps: 0,
    startedAt:      Date.now(),
  };
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export function addPlanStep(state: ProgressState, toolName: string): string {
  const stepId = `step_${state.steps.length + 1}`;
  const { called, done } = getToolLabels(toolName);
  state.steps.push({
    stepId,
    label:     called,
    doneLabel: done,
    status:    'running',
    agentSlug: toolName,
    startedAt: Date.now(),
  });
  state.totalSteps = state.steps.length;
  if (state.phase === 'routing' || state.phase === 'planning') {
    state.phase = 'executing';
  }
  return stepId;
}

export function markStepDone(
  state: ProgressState,
  toolName: string,
  output: unknown,
): void {
  const step = findLatestRunning(state, toolName);
  if (!step) return;
  step.status = 'done';
  step.completedAt = Date.now();
  delete step.toolActivity;

  const preview = previewToolResult(toolName, output);
  if (preview) step.resultSummary = preview;

  state.completedSteps = state.steps.filter(s => s.status === 'done').length;
}

export function markStepFailed(
  state: ProgressState,
  toolName: string,
  error: string,
): void {
  const step = findLatestRunning(state, toolName);
  if (!step) return;
  step.status = 'failed';
  step.completedAt = Date.now();
  delete step.toolActivity;
  step.error = error.length > 100 ? `${error.slice(0, 97)}...` : error;
  state.completedSteps = state.steps.filter(s => s.status === 'done').length;
}

export function setPhase(state: ProgressState, phase: ProgressPhase): void {
  state.phase = phase;
}

// ─── Conversion to ChannelTimeline ──────────────────────────────────────────

const STEP_MARKERS: Record<StepStatus, string> = {
  pending: '○',
  running: '●',
  done:    '✓',
  failed:  '✗',
};

export function toTimeline(state: ProgressState): ChannelTimeline {
  if (state.steps.length === 0) {
    return { liveLabel: phaseLabel(state.phase) };
  }

  const plan = state.steps.map(step => ({
    status: step.status,
    title: formatStepTitle(step),
  }));

  const activeStep = state.steps.find(s => s.status === 'running');
  const liveLabel = activeStep?.toolActivity
    ?? phaseLabel(state.phase);

  return {
    plan,
    liveLabel: `${liveLabel}  ${state.completedSteps}/${state.totalSteps}`,
  };
}

// ─── Execution trace for final card ────────────────────────────────────────

export function renderExecutionTrace(state: ProgressState): string {
  if (state.steps.length === 0) return '';

  const totalMs = Date.now() - state.startedAt;
  const totalSec = (totalMs / 1000).toFixed(1);

  const lines: string[] = [
    '---',
    `**Trace** (${state.steps.length} step${state.steps.length === 1 ? '' : 's'}, ${totalSec}s)`,
  ];

  for (const step of state.steps) {
    const marker = STEP_MARKERS[step.status];
    const name = (step.status === 'done' || step.status === 'failed')
      ? step.doneLabel
      : step.label;
    const durationSuffix = step.startedAt && step.completedAt
      ? ` (${((step.completedAt - step.startedAt) / 1000).toFixed(1)}s)`
      : '';
    const errorSuffix = step.error ? ` — ${step.error}` : '';
    lines.push(`${marker} ${name}${durationSuffix}${errorSuffix}`);
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findLatestRunning(state: ProgressState, toolName: string): ProgressStep | undefined {
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const s = state.steps[i]!;
    if (s.agentSlug === toolName && s.status === 'running') return s;
  }
  return undefined;
}

function formatStepTitle(step: ProgressStep): string {
  if (step.status === 'done' && step.resultSummary) {
    return `${step.label} — ${step.resultSummary}`;
  }
  if (step.status === 'failed' && step.error) {
    return `${step.label} — ${step.error}`;
  }
  if (step.status === 'running' && step.toolActivity) {
    return `${step.label}: ${step.toolActivity}`;
  }
  return step.label;
}

function phaseLabel(phase: ProgressPhase): string {
  switch (phase) {
    case 'routing':      return 'Routing…';
    case 'planning':     return 'Planning…';
    case 'executing':    return 'Working…';
    case 'synthesizing': return 'Preparing response…';
    case 'done':         return 'Done';
    case 'failed':       return 'Failed';
  }
}
