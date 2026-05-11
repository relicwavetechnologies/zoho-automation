import type { GroupChatWindow, GroupChatMessage, GroupChatSummary } from '../../domain/conversation/group-context';

function formatSummary(summary: GroupChatSummary): string {
  const parts: string[] = [];
  if (summary.summary) parts.push(summary.summary);
  if (summary.latestObjective) parts.push(`Current objective: ${summary.latestObjective}`);
  if (summary.activeEntities.length > 0) parts.push(`Key entities: ${summary.activeEntities.join(', ')}`);
  if (summary.completedActions.length > 0) parts.push(`Completed: ${summary.completedActions.join('; ')}`);
  if (summary.constraints.length > 0) parts.push(`Constraints: ${summary.constraints.join('; ')}`);
  return parts.join('\n');
}

function formatMessage(msg: GroupChatMessage): string {
  const prefix = msg.role === 'assistant' ? '@Divo' : `${msg.senderName}`;
  let line = `${prefix}: ${msg.content}`;
  if (msg.attachedFiles && msg.attachedFiles.length > 0) {
    line += ` [files: ${msg.attachedFiles.join(', ')}]`;
  }
  return line;
}

export function formatGroupContextForPrompt(window: GroupChatWindow): string {
  const sections: string[] = [
    'GROUP CHAT CONTEXT — Recent conversation from this chat.',
    'Use this context to understand what the team is discussing. Only respond to requests directed at you.',
  ];

  if (window.summary) {
    const summaryText = formatSummary(window.summary);
    if (summaryText) {
      sections.push('');
      sections.push('[Summary of older messages]');
      sections.push(summaryText);
    }
  }

  if (window.recentMessages.length > 0) {
    sections.push('');
    sections.push('[Recent messages]');
    for (const msg of window.recentMessages) {
      sections.push(formatMessage(msg));
    }
  }

  return sections.join('\n');
}
