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

const EXECUTION_TRACE_STEP_LIMIT = 5;

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
  const { called } = getToolLabels(toolName);
  state.steps.push({
    stepId,
    label:     called,
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
  const hiddenStepCount = Math.max(0, state.steps.length - EXECUTION_TRACE_STEP_LIMIT);
  const visibleSteps = hiddenStepCount > 0
    ? state.steps.slice(-EXECUTION_TRACE_STEP_LIMIT)
    : state.steps;
  const shownSuffix = hiddenStepCount > 0 ? `; showing last ${EXECUTION_TRACE_STEP_LIMIT}` : '';

  const lines: string[] = [
    '---',
    `**Trace** (${state.steps.length} step${state.steps.length === 1 ? '' : 's'}, ${totalSec}s${shownSuffix})`,
  ];

  for (const step of visibleSteps) {
    const marker = STEP_MARKERS[step.status];
    lines.push(`${marker} ${formatTraceLine(step)}`);
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

function formatTraceLine(step: ProgressStep): string {
  if (step.status === 'done') {
    return formatCompletedTraceLine(step);
  }
  if (step.status === 'failed') {
    return `${pastTenseLabel(step.agentSlug, false)}${step.error ? ` — ${step.error}` : ''}`;
  }
  if (step.status === 'running') {
    return `${step.label}${step.toolActivity ? ` — ${step.toolActivity}` : ''}`;
  }
  return step.label;
}

function formatCompletedTraceLine(step: ProgressStep): string {
  const summary = step.resultSummary ?? '';
  const taskTitle = extractCreatedTaskTitle(summary);
  if (taskTitle && isLarkTool(step.agentSlug)) {
    return `Created Lark task — ${taskTitle}`;
  }
  if (taskTitle && step.agentSlug === 'manageTodos') {
    return `Updated Divo checklist — ${taskTitle}`;
  }
  if (isLarkTool(step.agentSlug) && /no tasks? or tasklists? were found|no matching/i.test(summary)) {
    return 'Checked Lark tasks — no matching tasks found';
  }
  if (step.agentSlug === 'manageTodos' && /^added todo:/i.test(summary)) {
    return `Updated Divo checklist — ${cleanTodoTitle(summary)}`;
  }
  const label = pastTenseLabel(step.agentSlug, true);
  return summary ? `${label} — ${summary}` : label;
}

function pastTenseLabel(toolName: string, success: boolean): string {
  if (!success) {
    if (isLarkTool(toolName)) return 'Could not update Lark';
    if (toolName === 'manageTodos') return 'Could not update Divo checklist';
    return 'Failed';
  }
  if (isLarkTool(toolName)) return 'Updated Lark';
  if (toolName === 'manageTodos') return 'Updated Divo checklist';
  return getToolLabels(toolName).done;
}

function isLarkTool(toolName: string): boolean {
  return toolName === 'larkAgent'
    || toolName === 'agent_lark_ops'
    || toolName === 'larkTask';
}

function extractCreatedTaskTitle(summary: string): string | null {
  const match = summary.match(/Task\s+"([^"]+)"\s+has been created/i)
    ?? summary.match(/Created\s+(?:Lark\s+)?task\s+[":]\s*"?([^"\n.]+)"?/i)
    ?? summary.match(/Added todo:\s*"([^"]+)"/i);
  return match?.[1]?.trim() || null;
}

function cleanTodoTitle(summary: string): string {
  return extractCreatedTaskTitle(summary) ?? summary.replace(/^Added todo:\s*/i, '').trim();
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
