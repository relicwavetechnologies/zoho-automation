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
  /** call_tool → the tool it dispatched, so results settle on the same step. */
  private readonly dispatched = new Map<string, string>();
  /** Checklist items that were already done before this run touched the list. */
  private inheritedTodos: Set<string> | undefined = undefined;
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

  recordCall(toolName: string, args?: unknown): void {
    this.narration.unfreeze();
    if (this.progress.phase === 'synthesizing') {
      setPhase(this.progress, 'executing');
    }
    this.narration.flush();
    const slug = dispatchedToolId(toolName, args) ?? toolName;
    const { verb } = getToolLabels(slug);
    this.narration.pushActivityLine(verb);
    this.liveLabel = verb;

    this.dispatched.set(toolName, slug);
    addPlanStep(this.progress, slug);
  }

  recordResult(toolName: string, output: unknown): void {
    markStepDone(this.progress, this.dispatched.get(toolName) ?? toolName, output);
    if (toolName === 'manageTodos') {
      const todos = parseDeclaredTodos(output);
      if (todos) setDeclaredTodos(this.progress, this.thisRunsTodos(todos));
    }
    this.narration.completeCurrent();
    // Do not enter synthesizing here — more tool calls often follow in the same
    // supervisor stream. setSynthesizing() is called when final text starts.
  }

  recordFailure(toolName: string, error: string): void {
    markStepFailed(this.progress, this.dispatched.get(toolName) ?? toolName, error);
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

  /**
   * manageTodos is chat-scoped with a 24h TTL, so the list it echoes back can
   * still hold items completed for an earlier request. Counting those would open
   * a fresh run at "Step 4 of 4" — the exact dishonesty this card removed. Items
   * already done when this run first looked are treated as someone else's.
   */
  private thisRunsTodos(todos: readonly DeclaredTodo[]): DeclaredTodo[] {
    if (!this.inheritedTodos) {
      this.inheritedTodos = new Set(
        todos.filter(t => t.status === 'done').map(t => t.title),
      );
    }
    return todos.filter(t => !this.inheritedTodos!.has(t.title));
  }
}

/**
 * Production routes almost everything through the `call_tool` dispatcher, so the
 * tool name on the wire is always "call_tool" and the ledger read "Tool · 4
 * calls". The vendor the model actually reached is in the arguments.
 */
export function dispatchedToolId(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'call_tool' || typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const direct = record['toolId'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  // Some callers wrap the payload one level deeper.
  const nested = record['input'];
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as Record<string, unknown>)['toolId'];
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  }
  return undefined;
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
