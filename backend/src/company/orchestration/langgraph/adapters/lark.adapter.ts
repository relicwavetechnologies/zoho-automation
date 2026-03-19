import type { RuntimeChannelAdapter } from './channel.adapter';

export class LarkRuntimeAdapter implements RuntimeChannelAdapter {
  readonly channel = 'lark' as const;

  getBlockedToolIds(): string[] {
    return ['coding'];
  }

  buildStatusPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown> {
    return {
      type: 'lark_status',
      runId: input.runId,
      conversationId: input.conversationId,
      text: input.text,
      dedupeKey: input.dedupeKey,
      updateMode: 'in_place',
    };
  }

  buildApprovalPayload(input: {
    runId: string;
    conversationId: string;
    approvalId: string;
    summary: string;
  }): Record<string, unknown> {
    return {
      type: 'lark_approval',
      runId: input.runId,
      conversationId: input.conversationId,
      approvalId: input.approvalId,
      summary: input.summary,
      updateMode: 'single_card',
    };
  }

  buildFinalPayload(input: {
    runId: string;
    conversationId: string;
    text: string;
    dedupeKey: string;
  }): Record<string, unknown> {
    return {
      type: 'lark_final',
      runId: input.runId,
      conversationId: input.conversationId,
      text: input.text,
      dedupeKey: input.dedupeKey,
      updateMode: 'single_final_message',
    };
  }
}

export const larkRuntimeAdapter = new LarkRuntimeAdapter();

