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
    assert.ok(result.includes('── RECENT MESSAGES ──'));
    assert.ok(result.includes('[2026-05-13T06:30:00.000Z] Alice: Can you check the invoice?'));
    assert.ok(result.includes('[2026-05-13T06:30:00.000Z] Bob: I updated the spreadsheet'));
  });

  it('includes prose rolling summary when present', () => {
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
    assert.ok(result.includes('── ROLLING SUMMARY (older discussion) ──'));
    assert.ok(result.includes('Team discussed Q3 budget'));
    assert.ok(result.includes('Direction: Close budget reconciliation today'));
    assert.ok(result.includes('decided: Use the revised spreadsheet'));
    assert.ok(result.includes('blocker: Zoho export is delayed'));
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

  it('renders structured attachment context inside the original message', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', 'Please check this image', {
          id: 'om_123',
          attachments: [{
            kind: 'image',
            fileName: 'receipt.png',
            mimeType: 'image/png',
            inlineContext: '[Image: "receipt.png"\nOCR text:\nTotal $42]',
            isInlineComplete: true,
            ingestionStatus: 'indexed',
            fileAssetId: 'file_123',
            retrievalHint: 'Use contextSearch or documentRag with fileAssetId="file_123".',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('Bob: Please check this image'));
    assert.ok(result.includes('[internal attachment context: image "receipt.png"; image/png; status=indexed; fileAssetId=file_123]'));
    assert.ok(result.includes('Attachment placement: this upload belongs to this exact transcript message'));
    assert.ok(result.includes('OCR text:'));
    assert.ok(result.includes('Total $42'));
    assert.ok(result.includes('Use contextSearch or documentRag with fileAssetId="file_123"'));
  });

  it('instructs the model to bind this-image references to nearest inline attachment', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', '[image: screenshot.jpg]', {
          id: 'om_image',
          attachments: [{
            kind: 'image',
            fileName: 'screenshot.jpg',
            mimeType: 'image/jpeg',
            inlineContext: '[Image: "screenshot.jpg"\nDescription: A settings permission screen]',
            isInlineComplete: true,
            ingestionStatus: 'inline_only',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window, {
      senderName: 'Bob',
      content: 'summarize this image',
    });

    assert.ok(result.includes('nearest preceding message with [internal attachment context]'));
    assert.ok(result.includes('Inline attachment context is already in hand. Answer from it first'));
    assert.ok(result.includes('Attachment placement: this upload belongs to this exact transcript message; nearby "this image" references usually point here.'));
    assert.ok(result.includes('Description: A settings permission screen'));
    assert.ok(result.includes('▶ [now] Bob → @Divo: summarize this image'));
  });

  it('handles empty recent messages gracefully', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [],
      totalMessageCount: 0,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('GROUP CHAT CONTEXT'));
    assert.ok(!result.includes('── RECENT MESSAGES ──'));
  });

  it('appends current message with ▶ marker when provided', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'Here are the Q3 numbers'),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window, {
      senderName: 'Bob',
      content: 'make todos of the above message',
    });
    assert.ok(result.includes('── RECENT MESSAGES ──'));
    assert.ok(result.includes('Alice: Here are the Q3 numbers'));
    assert.ok(result.includes('▶ [now] Bob → @Divo: make todos of the above message'));
    // The ▶ line should be the last line
    const lines = result.split('\n');
    assert.ok(lines[lines.length - 1]!.startsWith('▶'));
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
    assert.ok(result.includes('── ROLLING SUMMARY (older discussion) ──'));
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
    assert.ok(result.length < 90_000);
  });
});
