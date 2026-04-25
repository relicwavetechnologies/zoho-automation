import type { ShareLabel } from './share-classifier';

export interface ShareCardData {
  shareId: string;
  fileName: string;
  requesterName: string;
  label: ShareLabel;
  companyId: string;
}

export function buildShareApprovalCard(data: ShareCardData): string {
  const labelText = data.label === 'critical' ? '🔴 Critical' : '🟡 Review';
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📤 File Share Request` },
      template: data.label === 'critical' ? 'red' : 'yellow',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**File**\n${data.fileName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Risk Level**\n${labelText}` } },
          { is_short: false, text: { tag: 'lark_md', content: `**Requested by**\n${data.requesterName}` } },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ Approve' },
            type: 'primary',
            value: JSON.stringify({ action: 'share_approve', shareId: data.shareId }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ Reject' },
            type: 'danger',
            value: JSON.stringify({ action: 'share_reject', shareId: data.shareId }),
          },
        ],
      },
    ],
  };

  return JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify(card),
  });
}

export function buildShareApprovedCard(fileName: string, adminName: string): string {
  const card = {
    header: { title: { tag: 'plain_text', content: '✅ Share Request Approved' }, template: 'green' },
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: `**${fileName}** was approved for sharing by ${adminName}.` },
    }],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

export function buildShareRejectedCard(fileName: string, adminName: string): string {
  const card = {
    header: { title: { tag: 'plain_text', content: '❌ Share Request Rejected' }, template: 'red' },
    elements: [{
      tag: 'div',
      text: { tag: 'lark_md', content: `**${fileName}** share request was rejected by ${adminName}.` },
    }],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}
