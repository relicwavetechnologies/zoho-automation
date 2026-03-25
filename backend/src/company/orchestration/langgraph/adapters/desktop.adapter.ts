import type { RuntimeChannelAdapter } from './channel.adapter';

export class DesktopRuntimeAdapter implements RuntimeChannelAdapter {
  readonly channel = 'desktop' as const;

  buildStatusPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown> {
    return {
      type: 'desktop_status',
      runId: input.runId,
      conversationId: input.conversationId,
      text: input.text,
      dedupeKey: input.dedupeKey,
    };
  }

  buildApprovalPayload(input: {
    runId: string;
    conversationId: string;
    approvalId: string;
    summary: string;
  }): Record<string, unknown> {
    return {
      type: 'desktop_approval',
      runId: input.runId,
      conversationId: input.conversationId,
      approvalId: input.approvalId,
      summary: input.summary,
    };
  }

  buildFinalPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown> {
    return {
      type: 'desktop_final',
      runId: input.runId,
      conversationId: input.conversationId,
      text: input.text,
      dedupeKey: input.dedupeKey,
    };
  }
}

export const desktopRuntimeAdapter = new DesktopRuntimeAdapter();
