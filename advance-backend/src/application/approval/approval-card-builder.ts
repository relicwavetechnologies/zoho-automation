/**
 * Builds the interactive Lark card sent to the manager for approval/rejection.
 * The card action payload follows: { kind: 'approval_decision', approvalId, decision }
 */

export interface ApprovalCardInput {
  approvalId:     string;
  toolId:         string;
  action:         string;
  summary:        string;
  requesterName:  string;
  departmentName: string;
}

export function buildApprovalCard(input: ApprovalCardInput): string {
  const { approvalId, toolId, action, summary, requesterName, departmentName } = input;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔐 Action Approval Request' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Requested by**\n${requesterName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Department**\n${departmentName}` } },
        ],
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Tool**\n${toolId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Action**\n${action}` } },
        ],
      },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**What the agent wants to do:**\n${summary}` },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag:  'button',
            text: { tag: 'plain_text', content: '✅ Approve' },
            type: 'primary',
            value: { kind: 'approval_decision', approvalId, decision: 'approved' },
          },
          {
            tag:  'button',
            text: { tag: 'plain_text', content: '❌ Reject' },
            type: 'danger',
            value: { kind: 'approval_decision', approvalId, decision: 'rejected' },
          },
        ],
      },
    ],
  };

  return JSON.stringify({
    msg_type: 'interactive',
    card:     JSON.stringify(card),
  });
}

/**
 * A batch card is deliberately more explicit than a normal one-action card:
 * the manager approves a fixed list of server-preflighted mutations, not an
 * open-ended Python script or a future agent decision.
 */
export function buildAutomationPlanApprovalCard(input: {
  approvalId: string;
  title: string;
  summary: string;
  requesterName: string;
  departmentName: string;
  actionCounts: Record<string, number>;
  invocationCount: number;
  /** Server-generated previews, never freeform Python source. */
  callPreview: readonly string[];
}): string {
  const actionSummary = Object.entries(input.actionCounts)
    .map(([action, count]) => `${count} ${action}`)
    .join(' · ');
  const preview = input.callPreview
    .slice(0, 12)
    .map((call, index) => `${index + 1}. ${call}`)
    .join('\n');
  const remaining = input.callPreview.length - 12;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔐 Automation Batch Approval' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Requested by**\n${input.requesterName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Department**\n${input.departmentName}` } },
        ],
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Exact calls**\n${input.invocationCount}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Actions**\n${actionSummary || 'none'}` } },
        ],
      },
      { tag: 'div', text: { tag: 'lark_md', content: `**Batch**\n${input.title}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**What will happen**\n${input.summary}` } },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Exact preflighted calls**\n${preview || 'No calls'}${remaining > 0 ? `\n… and ${remaining} more exact calls` : ''}`,
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: 'Approval permits only this preflighted batch. New, changed, or unplanned actions need a new approval.' }],
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ Approve exact batch' },
            type: 'primary',
            value: { kind: 'approval_decision', approvalId: input.approvalId, decision: 'approved' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ Reject' },
            type: 'danger',
            value: { kind: 'approval_decision', approvalId: input.approvalId, decision: 'rejected' },
          },
        ],
      },
    ],
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

export function buildApprovalResolutionCard(
  decision: 'approved' | 'rejected',
  resolvedByName: string,
  resolvedAt: Date,
): string {
  const emoji   = decision === 'approved' ? '✅' : '❌';
  const label   = decision === 'approved' ? 'Approved' : 'Rejected';
  const timeStr = resolvedAt.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${label} by ${resolvedByName}` },
      template: decision === 'approved' ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `Decision recorded at ${timeStr} UTC.` },
      },
    ],
  };

  return JSON.stringify({
    msg_type: 'interactive',
    card:     JSON.stringify(card),
  });
}
