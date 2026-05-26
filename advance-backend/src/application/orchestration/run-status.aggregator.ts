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
import { NarrationBuffer } from './narration-buffer';

const RECENT_CAP   = 5;
const LINE_MAX_CHARS = 80;
/** Show plan todo rail after the first tool call (layout A). */
const PLAN_STEP_THRESHOLD = 1;

export class RunStatusAggregator {
  private readonly recent: string[] = [];
  private liveLabel = 'Working…';
  private readonly progress: ProgressState = createProgressState();
  private readonly narration = new NarrationBuffer();
  private callCount = 0;

  /** Streamed model text for the status card; returns true if the card should refresh. */
  appendTextDelta(delta: string): boolean {
    return this.narration.append(delta);
  }

  recordCall(toolName: string): void {
    this.narration.unfreeze();
    if (this.progress.phase === 'synthesizing') {
      setPhase(this.progress, 'executing');
    }
    this.narration.flush();
    const { verb, called } = getToolLabels(toolName);
    this.narration.pushActivityLine(verb);
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
    this.narration.completeCurrent();
    // Do not enter synthesizing here — more tool calls often follow in the same
    // supervisor stream. setSynthesizing() is called when final text starts.
  }

  recordFailure(toolName: string, error: string): void {
    markStepFailed(this.progress, toolName, error);
  }

  /** Returns true when the status card should refresh. */
  updateActivity(message: string): boolean {
    const changed = this.narration.pushActivityLine(message);
    this.liveLabel = message;
    const running = this.progress.steps.find(s => s.status === 'running');
    if (running) running.toolActivity = message;
    return changed;
  }

  setSynthesizing(): void {
    if (this.progress.phase === 'synthesizing') return;
    setPhase(this.progress, 'synthesizing');
    this.liveLabel = 'Preparing response…';
    this.narration.freeze();
  }

  snapshot(): ChannelTimeline {
    const narrLines = this.narration.committedLines();
    const narrActive = this.narration.active();
    const base = this.callCount >= PLAN_STEP_THRESHOLD
      ? toTimeline(this.progress)
      : {
          phase:       phaseShortLabel(this.progress.phase),
          progressPct: computeProgressPct(this.progress),
          liveLabel:   narrLines.length || narrActive
            ? 'Working on your request'
            : this.liveLabel,
        };
    return {
      ...base,
      ...(narrLines.length ? { narration: [...narrLines] as ReadonlyArray<string> } : {}),
      ...(narrActive ? { narrationActive: narrActive } : {}),
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
