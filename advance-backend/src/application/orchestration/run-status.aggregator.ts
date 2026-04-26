/**
 * Per-run aggregator for supervisor status updates.
 * Tracks recent tool-call/result lines and the current live label.
 * One instance per orchestration run; the supervisor records events, the status channel reads snapshots.
 */

import { getToolLabels }    from './agents/tool-labels';
import { previewToolResult } from './agents/tool-result-preview';
import type { ChannelTimeline } from '../../domain/channel/outbound';

const RECENT_CAP   = 5;
const LINE_MAX_CHARS = 80;

export class RunStatusAggregator {
  private readonly recent: string[] = [];
  private liveLabel = 'Working…';

  recordCall(toolName: string): void {
    const { verb, called } = getToolLabels(toolName);
    this.liveLabel = verb;
    this.push(`[run]  ${called}`);
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
  }

  snapshot(): ChannelTimeline {
    return {
      ...(this.recent.length ? { recent: [...this.recent] as ReadonlyArray<string> } : {}),
      liveLabel: this.liveLabel,
    };
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
