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
      completedActions: ['Reconciled April'],
      constraints: ['Finance approval required'],
      blockers: ['Zoho export is delayed'],
      userGoals: ['Publish the monthly close'],
      superseded: ['Old CSV workflow'],
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
    assert.ok(result.includes('owner: Alice owns invoice checks'));
    assert.ok(result.includes('entity: Acme Corp'));
    assert.ok(result.includes('resource: Q3-report.xlsx'));
    assert.ok(result.includes('historically completed: Reconciled April'));
    assert.ok(result.includes('constraint: Finance approval required'));
    assert.ok(result.includes('historical goal: Publish the monthly close'));
    assert.ok(result.includes('superseded: Old CSV workflow'));
  });

  it('keeps every durable category visible when earlier fields are large', () => {
    const longItems = Array.from({ length: 20 }, (_, index) => `decision-${index}-${'x'.repeat(1_000)}`);
    const window: GroupChatWindow = {
      summary: {
        summary: 's'.repeat(80_000),
        activeEntities: ['Final entity'],
        decisions: longItems,
        openQuestions: longItems,
        owners: ['Final owner'],
        deadlines: longItems,
        mentionedResources: ['Final resource'],
        completedActions: ['Final completed action'],
        constraints: ['Final constraint'],
        blockers: longItems,
        userGoals: ['Final goal'],
        superseded: ['Final superseded item'],
        sourceMessageCount: 200,
        updatedAt: new Date().toISOString(),
      },
      recentMessages: [msg('Alice', 'Newest message')],
      totalMessageCount: 201,
    };

    const result = formatGroupContextForPrompt(window);
    assert.match(result, /owner: Final owner/);
    assert.match(result, /entity: Final entity/);
    assert.match(result, /resource: Final resource/);
    assert.match(result, /historically completed: Final completed action/);
    assert.match(result, /constraint: Final constraint/);
    assert.match(result, /historical goal: Final goal/);
    assert.match(result, /superseded: Final superseded item/);
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

  it('names a workspace attachment without reproducing any of its contents', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', 'Please check this image', {
          id: 'om_123',
          attachments: [{
            kind: 'image',
            fileName: 'receipt.png',
            mimeType: 'image/png',
            larkFileKey: 'file_v3_receipt',
            ingestionStatus: 'workspace',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('Bob: Please check this image'));
    // The room can say the file was shared and whether Divo read it — never that
    // the run holding this transcript has it, which is false for anyone but the
    // sender.
    assert.ok(result.includes('[internal attachment context: image "receipt.png"; image/png; shared in the room]'));
    assert.ok(!result.includes('status=workspace'));
    assert.ok(result.includes('Attachment placement: this upload belongs to this exact transcript message'));
    // The transcript is a pointer, not a copy: no extracted text, and no
    // instruction to reach for a retrieval tool that no longer exists.
    assert.ok(!result.includes('OCR text:'));
    assert.ok(!/contextSearch|documentRag|fileAssetId/.test(result));
  });

  it('states why an unsupported attachment was refused instead of guessing at it', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', 'here you go', {
          id: 'om_unsupported',
          attachments: [{
            kind: 'file',
            fileName: 'clip.mp4',
            mimeType: 'video/mp4',
            ingestionStatus: 'unsupported',
            inlineContext: 'Divo cannot open video files yet, so this one was not read.',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('not read by Divo'));
    assert.ok(result.includes('Divo cannot open video files yet, so this one was not read.'));
  });

  it('tells the model where a sent file actually lives', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Bob', '[image: screenshot.jpg]', {
          id: 'om_image',
          attachments: [{
            kind: 'image',
            fileName: 'screenshot.jpg',
            mimeType: 'image/jpeg',
            ingestionStatus: 'workspace',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);

    assert.ok(result.includes('nearest preceding message with [internal attachment context]'));
    // Only this request's own attachments are in the workspace. A file another
    // participant sent went to their container, so promising it here would have
    // the model answer about a file it never opened.
    assert.ok(result.includes('Files listed under [ATTACHED_FILES] for the current request are in your workspace'));
    // Check, then report — a file the sender posted earlier is still in their own
    // `.divo/inbox` on the durable volume, so denying it outright would refuse a
    // file the container holds.
    assert.ok(result.includes('look in your workspace first'));
    assert.ok(result.includes('.divo/inbox'));
    assert.ok(result.includes('Only if it is not there'));
    assert.ok(result.includes('never say you opened one you did not'));
    assert.ok(!result.includes('Every file sent in this chat is saved in your workspace'));
    assert.ok(result.includes('Attachment placement: this upload belongs to this exact transcript message; nearby "this image" references usually point here.'));
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

  it('keeps the current request out of the historical reference block', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'Here are the Q3 numbers'),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextForPrompt(window);
    assert.ok(result.includes('── RECENT MESSAGES ──'));
    assert.ok(result.includes('Alice: Here are the Q3 numbers'));
    assert.ok(!result.includes('make todos of the above message'));
    assert.ok(!result.includes('▶'));
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
