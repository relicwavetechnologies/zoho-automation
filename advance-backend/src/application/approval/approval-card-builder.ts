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
