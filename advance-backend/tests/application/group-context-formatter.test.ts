import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGroupContextForPrompt,
  selectRecentMessagesForTranscript,
} from '../../src/application/chat-context/group-context-formatter.ts';
import type { GroupChatWindow, GroupChatSummary, GroupChatMessage } from '../../src/domain/conversation/group-context.ts';

function msg(name: string, content: string, opts?: Partial<GroupChatMessage>): GroupChatMessage {
  return {
    id: `msg-${Date.now()}`,
    senderOpenId: `ou_${name}`,
    senderName: name,
    role: 'user',
    content,
    createdAt: '2026-05-13T06:30:00.000Z',
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
    assert.ok(result.includes('[Recent raw group transcript'));
    assert.ok(result.includes('[2026-05-13T06:30:00.000Z] Alice: Can you check the invoice?'));
    assert.ok(result.includes('[2026-05-13T06:30:00.000Z] Bob: I updated the spreadsheet'));
  });

  it('includes structured rolling summary when present', () => {
    const summary: GroupChatSummary = {
      summary: 'Team discussed Q3 budget',
      latestDirection: 'Close budget reconciliation today',
      activeEntities: ['Acme Corp', 'INV-2345'],
      decisions: ['Use the revised spreadsheet'],
      openQuestions: ['Who sends the final note?'],
      owners: ['Alice owns invoice checks'],
      deadlines: ['Today EOD'],
      mentionedResources: ['Q3-report.xlsx'],
      completedActions: [],
      constraints: [],
      blockers: ['Zoho export is delayed'],
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
    assert.ok(result.includes('[Rolling summary of older group discussion]'));
    assert.ok(result.includes('Summary: Team discussed Q3 budget'));
    assert.ok(result.includes('Latest direction: Close budget reconciliation today'));
    assert.ok(result.includes('Decisions: Use the revised spreadsheet'));
    assert.ok(result.includes('Key entities: Acme Corp; INV-2345'));
    assert.ok(result.includes('Files and links: Q3-report.xlsx'));
    assert.ok(result.includes('Blockers: Zoho export is delayed'));
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
    assert.ok(!result.includes('[Recent raw group transcript'));
  });

  it('handles partially populated legacy summary JSON safely', () => {
    const window: GroupChatWindow = {
      summary: {
        summary: 'Old summary without array fields',
        sourceMessageCount: 12,
        updatedAt: new Date().toISOString(),
      } as GroupChatSummary,
      recentMessages: [],
      totalMessageCount: 12,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('Old summary without array fields'));
  });

  it('selects newest transcript messages within budget and returns chronological order', () => {
    const messages = [
      msg('A', 'old ' + 'x'.repeat(200)),
      msg('B', 'middle ' + 'x'.repeat(200)),
      msg('C', 'new ' + 'x'.repeat(200)),
    ];

    const selected = selectRecentMessagesForTranscript(messages, 180);

    assert.deepEqual(selected.map(m => m.senderName), ['B', 'C']);
  });

  it('truncates a single oversized raw transcript message', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [msg('Alice', 'x'.repeat(100_000))],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('[truncated]'));
    assert.ok(result.length < 70_000);
  });
});
