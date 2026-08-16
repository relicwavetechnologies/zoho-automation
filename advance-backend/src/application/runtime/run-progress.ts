import type { ChannelPlanStepStatus } from '../../domain/channel/outbound';

/**
 * What a running container reports about itself, as it happens.
 *
 * These describe the *run*, not the surface watching it: the container emits the
 * same frames whoever asked. Keeping the vocabulary neutral here is what lets a
 * second surface subscribe without the runtime learning it exists.
 */

/** One subagent working under a tool call. */
export interface RunProgressChild {
  /** The agent's role — "scout", "reviewer" — which is what names it on screen. */
  readonly label: string;
  readonly status: ChannelPlanStepStatus;
  /** What it was asked to do, in the words the run gave it. */
  readonly detail?: string;
  /** How long it has been going, while it still is. Absent once it settles. */
  readonly elapsed?: string;
}

/** One line of the checklist the run declared. */
export interface RunProgressTodo {
  readonly title: string;
  readonly status: ChannelPlanStepStatus;
}

/**
 * What a tool reported about the work underneath it. Both arrive as tool
 * details from the container, so they travel on the same events rather than
 * each earning a channel of its own.
 */
export interface RunProgressDetail {
  readonly children?: readonly RunProgressChild[];
  readonly todos?: readonly RunProgressTodo[];
  /** What the call turned out to be — a skill's name, known only on the way out. */
  readonly detail?: string;
}

export type RunProgressEvent =
  | {
      readonly type: 'starting';
      readonly stage: 'workspace' | 'container';
      readonly label: string;
    }
  | { readonly type: 'ready' | 'thinking' | 'working' | 'writing' }
  /** One ordered fragment of assistant prose, exactly as the model emitted it. */
  | {
      readonly type: 'answer_delta';
      readonly index: number;
      readonly delta: string;
    }
  /** Discard an abandoned assistant prefix before a retry continues. */
  | { readonly type: 'answer_reset' }
  /** A whole sentence the model finished saying between its tool calls. */
  | { readonly type: 'say'; readonly index: number; readonly text: string }
  /**
   * A whole sentence of the model's reasoning.
   *
   * Separate from `say` because the two are read differently and one of them is
   * not shown at all on a card read by a whole chat. Same shape, same cap, same
   * sentence-cutting — the difference is who it was addressed to.
   */
  | { readonly type: 'thought'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool_start';
      readonly callId: string;
      readonly toolName: string;
      readonly toolId?: string;
      /** What this call is about, from the argument that names the work. */
      readonly detail?: string;
    }
  | ({
      readonly type: 'tool_progress';
      readonly callId: string;
      readonly toolName: string;
    } & RunProgressDetail)
  | ({
      readonly type: 'tool_end';
      readonly callId: string;
      readonly toolName: string;
      readonly isError: boolean;
    } & RunProgressDetail)
  /**
   * A document the run finished and stored, ready to be read beside the thread.
   *
   * Its own frame rather than a `tool_end` detail, because it is not a line of
   * the work log — it is the work. The log says a thing happened; this says a
   * thing now exists and where to get it. A surface that cannot show a document
   * ignores this frame, which is the same thing it does with every other
   * capability it lacks.
   *
   * The body is deliberately absent. It is already stored under `artifactId`,
   * and a report can be far larger than a progress frame should ever be.
   */
  | {
      readonly type: 'artifact';
      readonly artifactId: string;
      readonly title: string;
      readonly mime: string;
      readonly version: number;
    };
