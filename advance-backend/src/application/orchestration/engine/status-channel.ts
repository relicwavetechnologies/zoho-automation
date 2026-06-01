import type { StatusHandle }  from '../../channels/channel.adapter';
import type { StatusUpdate }  from '../../../domain/channel/outbound';

export type { StatusHandle };

export interface ToolStartPayload {
  readonly callId: string;
  readonly name: string;
  readonly family: string;
  readonly args: unknown;
  /** Present-progressive label, e.g. "Reading Zoho Books…". */
  readonly verb?: string;
}

export interface ToolEndPayload {
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
  /** Past-tense label, e.g. "Read", "Searched". */
  readonly past?: string;
}

export interface StatusChannel {
  sendStatus(update: StatusUpdate): Promise<StatusHandle | null>;
  editStatus(handle: StatusHandle | null, update: StatusUpdate): Promise<StatusHandle | null>;
  /** Optional: emit a discrete tool-start event (desktop/streaming UIs). */
  emitToolStart?(event: ToolStartPayload): void;
  /** Optional: emit a discrete tool-end event. */
  emitToolEnd?(event: ToolEndPayload): void;
  /** Optional: forward each model text-delta chunk. */
  emitTextDelta?(delta: string): void;
}
