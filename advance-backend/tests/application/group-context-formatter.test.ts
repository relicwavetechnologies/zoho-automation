import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatGroupContextForPrompt } from '../../src/application/chat-context/group-context-formatter.ts';
import type { GroupChatWindow, GroupChatSummary, GroupChatMessage } from '../../src/domain/conversation/group-context.ts';

function msg(name: string, content: string, opts?: Partial<GroupChatMessage>): GroupChatMessage {
  return {
    id: `msg-${Date.now()}`,
    senderOpenId: `ou_${name}`,
    senderName: name,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    botMentioned: false,
    ...opts,
  };
}

describe('formatGroupContextForPrompt', () => {
  it('includes header and recent messages', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'Can you check the invoice?'),
        msg('Bob', 'I updated the spreadsheet'),
      ],
      totalMessageCount: 2,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('GROUP CHAT CONTEXT'));
    assert.ok(result.includes('Alice: Can you check the invoice?'));
    assert.ok(result.includes('Bob: I updated the spreadsheet'));
  });

  it('includes summary section when present', () => {
    const summary: GroupChatSummary = {
      summary: 'Team discussed Q3 budget',
      activeEntities: ['Acme Corp', 'INV-2345'],
      completedActions: [],
      constraints: [],
      userGoals: [],
      sourceMessageCount: 50,
      updatedAt: new Date().toISOString(),
    };

    const window: GroupChatWindow = {
      summary,
      recentMessages: [msg('Alice', 'Hello')],
      totalMessageCount: 51,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('[Summary of older messages]'));
    assert.ok(result.includes('Team discussed Q3 budget'));
    assert.ok(result.includes('Acme Corp, INV-2345'));
  });

  it('formats assistant messages with @Divo prefix', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Divo', 'Found 3 invoices', { role: 'assistant', senderOpenId: 'divo-bot' }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('@Divo: Found 3 invoices'));
  });

  it('includes file attachments in message', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', 'Here is the report', { attachedFiles: ['Q3-report.xlsx'] }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('[files: Q3-report.xlsx]'));
  });

  it('handles empty recent messages gracefully', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [],
      totalMessageCount: 0,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('GROUP CHAT CONTEXT'));
    assert.ok(!result.includes('[Recent messages]'));
  });
});
