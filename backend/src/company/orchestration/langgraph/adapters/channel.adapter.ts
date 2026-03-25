import type { RuntimeChannel } from '../runtime.types';

export interface RuntimeChannelAdapter {
  readonly channel: RuntimeChannel;
  buildStatusPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown>;
  buildApprovalPayload(input: {
    runId: string;
    conversationId: string;
    approvalId: string;
    summary: string;
  }): Record<string, unknown>;
  buildFinalPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown>;
}
