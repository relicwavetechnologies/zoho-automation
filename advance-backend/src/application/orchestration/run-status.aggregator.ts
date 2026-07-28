/**
 * Per-run aggregator for supervisor status updates.
 * Tracks plan steps, the declared checklist (when the model committed to one),
 * and the current live label.
 * One instance per orchestration run; the supervisor records events, the status channel reads snapshots.
 */

import { getToolLabels }    from './agents/tool-labels';
import type { ChannelTimeline } from '../../domain/channel/outbound';
import {
  type DeclaredTodo,
  type ProgressState,
  createProgressState,
  addPlanStep,
  markStepDone,
  markStepFailed,
  setPhase,
  setDeclaredTodos,
  toTimeline,
  renderExecutionTrace,
} from './engine/progress-state';
import { NarrationBuffer } from './narration-buffer';

export class RunStatusAggregator {
  private liveLabel = 'Working…';
  private subject: string | undefined = undefined;
  private readonly progress: ProgressState = createProgressState();
  private readonly narration = new NarrationBuffer();

  /** What the user asked for, in a few words — titles the status card. */
  setSubject(subject: string | undefined): void {
    this.subject = subject?.trim() || undefined;
  }

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
    const { verb } = getToolLabels(toolName);
    this.narration.pushActivityLine(verb);
    this.liveLabel = verb;

    addPlanStep(this.progress, toolName);
  }

  recordResult(toolName: string, output: unknown): void {
    markStepDone(this.progress, toolName, output);
    if (toolName === 'manageTodos') {
      const todos = parseDeclaredTodos(output);
      if (todos) setDeclaredTodos(this.progress, todos);
    }
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
    const narrLines  = this.narration.committedLines();
    const narrActive = this.narration.active();
    const base = toTimeline(this.progress);
    return {
      ...base,
      liveLabel: narrActive ?? base.liveLabel ?? this.liveLabel,
      ...(this.subject ? { subject: this.subject } : {}),
      ...(narrLines.length ? { narration: [...narrLines] as ReadonlyArray<string> } : {}),
      ...(narrActive ? { narrationActive: narrActive } : {}),
    };
  }

  getExecutionTrace(): string {
    return renderExecutionTrace(this.progress);
  }
}

/**
 * Read the checklist out of a manageTodos result. The tool renders every live
 * todo as "[status] 1. Title (id:…)" — the only place a run learns a total it
 * can honestly divide by, because the model committed to that list itself.
 */
const TODO_LINE = /^\s*\[(pending|in_progress|done|cancelled)\]\s*\d+\.\s*(.+?)\s*\(id:[^)]*\)\s*$/i;

export function parseDeclaredTodos(output: unknown): DeclaredTodo[] | undefined {
  const text = typeof output === 'string' ? output : undefined;
  if (!text) return undefined;

  const todos: DeclaredTodo[] = [];
  for (const line of text.split('\n')) {
    const match = TODO_LINE.exec(line);
    if (!match) continue;
    todos.push({
      status: match[1]!.toLowerCase() as DeclaredTodo['status'],
      title:  match[2]!.trim(),
    });
  }
  if (todos.length) return todos;
  // "Todos cleared." / "No todos for this chat." both mean: no declared plan.
  return /todos cleared|no todos for this chat/i.test(text) ? [] : undefined;
}
