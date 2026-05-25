/**
 * Per-run aggregator for supervisor status updates.
 * Tracks recent tool-call/result lines, plan steps, and the current live label.
 * One instance per orchestration run; the supervisor records events, the status channel reads snapshots.
 */

import { getToolLabels }    from './agents/tool-labels';
import { previewToolResult } from './agents/tool-result-preview';
import type { ChannelTimeline } from '../../domain/channel/outbound';
import {
  type ProgressState,
  createProgressState,
  addPlanStep,
  markStepDone,
  markStepFailed,
  setPhase,
  toTimeline,
  computeProgressPct,
  phaseShortLabel,
  renderExecutionTrace,
} from './engine/progress-state';

const RECENT_CAP   = 5;
const LINE_MAX_CHARS = 80;
/** Show plan todo rail after the first tool call (layout A). */
const PLAN_STEP_THRESHOLD = 1;

export class RunStatusAggregator {
  private readonly recent: string[] = [];
  private liveLabel = 'Working…';
  private readonly progress: ProgressState = createProgressState();
  private callCount = 0;

  recordCall(toolName: string): void {
    const { verb, called } = getToolLabels(toolName);
    this.liveLabel = verb;
    this.push(`[run]  ${called}`);

    this.callCount++;
    addPlanStep(this.progress, toolName);
  }

  recordResult(toolName: string, output: unknown): void {
    const { done } = getToolLabels(toolName);
    const preview = previewToolResult(toolName, output);
    const doneLine = preview ? `[done] ${done} — ${preview}` : `[done] ${done}`;

    const { called } = getToolLabels(toolName);
    const runLine    = `[run]  ${called}`;
    const lastRunIdx = this.recent.lastIndexOf(runLine);

    if (lastRunIdx !== -1) {
      this.recent[lastRunIdx] = this.trim(doneLine);
    } else {
      this.push(doneLine);
    }

    markStepDone(this.progress, toolName, output);
    if (
      this.progress.completedSteps === this.progress.totalSteps
      && !this.progress.steps.some(s => s.status === 'running')
    ) {
      setPhase(this.progress, 'synthesizing');
      this.liveLabel = 'Preparing response…';
    }
  }

  recordFailure(toolName: string, error: string): void {
    markStepFailed(this.progress, toolName, error);
  }

  updateActivity(message: string): void {
    this.liveLabel = message;
    const running = this.progress.steps.find(s => s.status === 'running');
    if (running) running.toolActivity = message;
  }

  setSynthesizing(): void {
    setPhase(this.progress, 'synthesizing');
  }

  snapshot(): ChannelTimeline {
    const base = this.callCount >= PLAN_STEP_THRESHOLD
      ? toTimeline(this.progress)
      : {
          phase:       phaseShortLabel(this.progress.phase),
          progressPct: computeProgressPct(this.progress),
          liveLabel:   this.liveLabel,
        };
    return {
      ...base,
      ...(this.recent.length ? { recent: [...this.recent] as ReadonlyArray<string> } : {}),
    };
  }

  getExecutionTrace(): string {
    return renderExecutionTrace(this.progress);
  }

  private trim(line: string): string {
    return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line;
  }

  private push(line: string): void {
    const trimmed = this.trim(line);
    if (this.recent[this.recent.length - 1] === trimmed) return;
    this.recent.push(trimmed);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }
}
