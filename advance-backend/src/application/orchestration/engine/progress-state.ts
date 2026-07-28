/**
 * Progress state tracking for the Lark bubble UX.
 *
 * Tracks plan steps (agent delegations / tool calls) through their lifecycle
 * and converts to ChannelTimeline for rendering via buildStatusCard().
 * Also renders an execution trace markdown block for the final card.
 */

import type {
  ChannelDeclaredPlan,
  ChannelLedgerRow,
  ChannelPlanStep,
  ChannelRunState,
  ChannelTimeline,
  ChannelToolFamily,
} from '../../../domain/channel/outbound';
import { getToolLabels, hasToolLabels } from '../agents/tool-labels';
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

/** A checklist item the model committed to through manageTodos. */
export interface DeclaredTodo {
  title:  string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
}

export interface ProgressState {
  phase:          ProgressPhase;
  steps:          ProgressStep[];
  /**
   * Tool calls seen so far. This is a count, not a total: the run cannot know
   * how many calls it will need, so this must never become a denominator.
   */
  totalSteps:     number;
  completedSteps: number;
  startedAt:      number;
  /** Set only when the model declared a checklist — the one honest denominator. */
  declaredTodos?: DeclaredTodo[];
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

  // Clean before previewing: previewToolResult truncates at 80 chars, so a later
  // strip would leave a half-eaten "[done] 1." behind.
  const preview = previewToolResult(toolName, cleanToolOutput(toolName, output));
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

/** Record the checklist the model declared, replacing any earlier snapshot. */
export function setDeclaredTodos(state: ProgressState, todos: readonly DeclaredTodo[]): void {
  const live = todos.filter(t => t.status !== 'cancelled');
  if (live.length === 0) {
    delete state.declaredTodos;
    return;
  }
  state.declaredTodos = live.map(t => ({ ...t }));
}

// ─── Conversion to ChannelTimeline ──────────────────────────────────────────

const STEP_MARKERS: Record<StepStatus, string> = {
  pending: '○',
  running: '●',
  done:    '✓',
  failed:  '✗',
};

export function inferToolFamily(agentSlug: string): ChannelToolFamily {
  if (/zoho/i.test(agentSlug)) return 'zoho';
  if (/lark/i.test(agentSlug)) return 'lark';
  if (/google|gmail/i.test(agentSlug)) return 'google';
  if (/context/i.test(agentSlug)) return 'context';
  if (/manageTodos|scheduleTask|listScheduled|cancelScheduled|runScheduled/i.test(agentSlug)) {
    return 'orchestration';
  }
  return 'other';
}

/**
 * Coarse liveness for channels that draw a bar (desktop, AirNote).
 *
 * Without a declared checklist there is no completion ratio to compute — the
 * old formula divided completed steps by "steps seen so far", which is the same
 * number, so it always read as nearly finished. This ramps monotonically and
 * stops well short of 100 until the run actually reaches a terminal phase.
 */
export function computeProgressPct(state: ProgressState): number {
  switch (state.phase) {
    case 'routing':      return 8;
    case 'planning':     return 18;
    case 'synthesizing': return 92;
    case 'done':         return 100;
    case 'failed':       return 100;
    case 'executing': {
      const todos = state.declaredTodos;
      if (todos?.length) {
        const done = todos.filter(t => t.status === 'done').length;
        return Math.min(90, 20 + Math.round((done / todos.length) * 70));
      }
      return Math.min(75, 25 + state.steps.length * 4);
    }
    default: return 10;
  }
}

export function toTimeline(state: ProgressState): ChannelTimeline {
  const progressPct = computeProgressPct(state);
  const phase       = formatPhaseHeader(state);
  const declared    = toDeclaredPlan(state);
  const base: ChannelTimeline = {
    phase,
    state:        toRunState(state.phase),
    progressPct,
    actionCount:  state.steps.length,
    startedAtMs:  state.startedAt,
    ...(declared ? { declared } : {}),
  };

  if (state.steps.length === 0) {
    return { ...base, liveLabel: phaseLabel(state.phase) };
  }

  const plan: ChannelPlanStep[] = state.steps.map(step => {
    const subtitle = formatStepSubtitle(step);
    return {
      status:     step.status,
      title:      step.label,
      toolFamily: inferToolFamily(step.agentSlug),
      ...(subtitle ? { subtitle } : {}),
    };
  });

  const activeStep = state.steps.find(s => s.status === 'running');
  const liveLabel  = activeStep?.toolActivity ?? activeStep?.label ?? phaseLabel(state.phase);
  const ledger     = buildLedger(state);

  return {
    ...base,
    completedSteps: state.completedSteps,
    totalSteps:     state.totalSteps,
    plan,
    liveLabel,
    ...(ledger.length ? { ledger } : {}),
  };
}

/** Fraction only when the model declared a checklist; otherwise undefined. */
function toDeclaredPlan(state: ProgressState): ChannelDeclaredPlan | undefined {
  const todos = state.declaredTodos;
  if (!todos?.length) return undefined;
  const done    = todos.filter(t => t.status === 'done').length;
  const current = todos.find(t => t.status === 'in_progress');
  const next    = todos.find(t => t.status === 'pending');
  return {
    done,
    total: todos.length,
    ...(current ? { current: current.title } : {}),
    ...(next    ? { next:    next.title    } : {}),
  };
}

function toRunState(phase: ProgressPhase): ChannelRunState {
  switch (phase) {
    case 'routing':      return 'thinking';
    case 'planning':     return 'planning';
    case 'executing':    return 'working';
    case 'synthesizing': return 'writing';
    case 'done':         return 'done';
    case 'failed':       return 'blocked';
    default:             return 'working';
  }
}

/**
 * Collapse consecutive calls to the same tool family into one row, so an
 * eleven-call run reads as three lines instead of eleven.
 */
export function buildLedger(state: ProgressState): ChannelLedgerRow[] {
  const rows: ChannelLedgerRow[] = [];

  for (const step of state.steps) {
    const family  = inferToolFamily(step.agentSlug);
    const label   = ledgerLabel(step, family);
    const outcome = ledgerOutcome(step);
    const last    = rows[rows.length - 1];

    if (last && last.label === label && last.status !== 'running' && step.status !== 'running') {
      rows[rows.length - 1] = {
        label,
        count:   last.count + 1,
        // Marker and outcome must describe the same call, or a retry that
        // succeeded after a 429 renders as "✗ Zoho — Created INV-1043".
        outcome: outcome || last.outcome,
        status:  outcome ? step.status : last.status,
      };
      continue;
    }
    rows.push({ label, count: 1, outcome, status: step.status });
  }

  return rows;
}

const FAMILY_LEDGER_LABEL: Record<ChannelToolFamily, string> = {
  zoho:          'Zoho',
  lark:          'Lark',
  google:        'Google',
  context:       'Context',
  orchestration: 'Plan',
  other:         '',
};

function ledgerLabel(step: ProgressStep, family: ChannelToolFamily): string {
  const byFamily = FAMILY_LEDGER_LABEL[family];
  if (byFamily) return byFamily;
  // 'other' covers skill discovery and orchestration verbs, which have nouns.
  if (hasToolLabels(step.agentSlug)) return getToolLabels(step.agentSlug).done;
  // Everything else is a dispatched vendor tool. Derive the vendor from the id
  // ("airtableRecords" → "Airtable") so a tool added later needs no map entry.
  return vendorFromToolId(step.agentSlug);
}

/** First word of a tool id, title-cased: airtableRecords → Airtable, oms_site_data → Oms. */
export function vendorFromToolId(toolId: string): string {
  const head = toolId
    .replace(/^agent_/, '')
    .split(/[_\-.]/)[0]!
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')[0]!
    .trim();
  if (!head) return 'Tool';
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function ledgerOutcome(step: ProgressStep): string {
  if (step.status === 'done')    return step.resultSummary ?? pastTenseLabel(step.agentSlug, true);
  if (step.status === 'failed')  return step.error ?? 'Failed';
  if (step.status === 'running') return step.toolActivity ?? step.label;
  return step.label;
}

/**
 * manageTodos returns its confirmation followed by the whole checklist, so the
 * model always sees current state. Users need the confirmation only — the raw
 * list carries `[pending]` markers and internal ids. Cleaned here, once, so
 * every reader (ledger, trace, plan subtitle) gets the same clean summary.
 */
function cleanToolOutput(toolName: string, output: unknown): unknown {
  if (toolName !== 'manageTodos' || typeof output !== 'string') return output;
  return output
    .replace(/\s*\[(?:pending|in_progress|done|cancelled)\]\s*\d+\..*$/is, '')
    .replace(/\s*\(id:[^)]*\)/gi, '')
    .trim();
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

function formatStepSubtitle(step: ProgressStep): string | undefined {
  if (step.status === 'done' && step.resultSummary) return step.resultSummary;
  if (step.status === 'failed' && step.error) return step.error;
  if (step.status === 'running' && step.toolActivity) return step.toolActivity;
  return undefined;
}

/**
 * Phase line for channels that show one. A fraction appears only when the model
 * declared a checklist; otherwise the action count is shown as a count-up,
 * because the run has no way to know how many calls remain.
 */
function formatPhaseHeader(state: ProgressState): string {
  const phaseName = phaseShortLabel(state.phase);
  const todos = state.declaredTodos;
  if (todos?.length) {
    const done = todos.filter(t => t.status === 'done').length;
    return `${phaseName} · ${Math.min(done + 1, todos.length)}/${todos.length}`;
  }
  if (state.steps.length > 0) {
    return `${phaseName} · ${state.steps.length} action${state.steps.length === 1 ? '' : 's'}`;
  }
  return phaseName;
}

export function phaseShortLabel(phase: ProgressPhase): string {
  switch (phase) {
    case 'routing':      return 'Thinking';
    case 'planning':     return 'Planning';
    case 'executing':    return 'Executing';
    case 'synthesizing': return 'Synthesizing';
    case 'done':         return 'Done';
    case 'failed':       return 'Blocked';
    default:             return 'Working';
  }
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
    case 'routing':      return 'Thinking…';
    case 'planning':     return 'Planning…';
    case 'executing':    return 'Working…';
    case 'synthesizing': return 'Preparing response…';
    case 'done':         return 'Done';
    case 'failed':       return 'Failed';
  }
}
