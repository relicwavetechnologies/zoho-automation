import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGroupContextForPrompt,
  formatGroupContextMultimodal,
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

describe('formatGroupContextMultimodal', () => {
  it('returns image parts at exact message positions when cloudinaryUrl present', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'Here is the chart', {
          id: 'om_200',
          attachments: [{
            kind: 'image',
            fileName: 'chart.png',
            mimeType: 'image/png',
            cloudinaryUrl: 'https://res.cloudinary.com/demo/chart.png',
            inlineContext: '[Image: "chart.png"\nOCR text:\nQ1: $2.4M]',
            isInlineComplete: true,
            ingestionStatus: 'indexed',
          }],
        }),
        msg('Bob', 'Looks good'),
      ],
      totalMessageCount: 2,
    };

    const result = formatGroupContextMultimodal(window, {
      senderName: 'Alice',
      content: 'summarize this chart',
    });

    assert.ok(result.hasImages);
    assert.ok(result.systemHeader.includes('GROUP CHAT CONTEXT'));

    const imagePartsCount = result.parts.filter(p => p.type === 'image').length;
    assert.equal(imagePartsCount, 1);

    const imagePart = result.parts.find(p => p.type === 'image');
    assert.ok(imagePart);
    assert.equal(imagePart.type, 'image');
    if (imagePart.type === 'image') {
      assert.equal(imagePart.url, 'https://res.cloudinary.com/demo/chart.png');
    }

    // Image should appear after the message text and before Bob's message
    const partTypes = result.parts.map(p => p.type);
    const imgIdx = partTypes.indexOf('image');
    assert.ok(imgIdx > 0, 'image should not be first');

    // Current request marker should be last
    const lastPart = result.parts.at(-1);
    assert.ok(lastPart?.type === 'text' && lastPart.text.startsWith('▶'));
  });

  it('falls back to text-only when no cloudinaryUrl present', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'Check this', {
          id: 'om_201',
          attachments: [{
            kind: 'image',
            fileName: 'screenshot.png',
            mimeType: 'image/png',
            inlineContext: '[Image: "screenshot.png"\nDescription: A dialog]',
            isInlineComplete: true,
            ingestionStatus: 'inline_only',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextMultimodal(window);

    assert.equal(result.hasImages, false);
    const imagePartsCount = result.parts.filter(p => p.type === 'image').length;
    assert.equal(imagePartsCount, 0);

    // Should still have the inline context as text
    const textContent = result.parts.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n');
    assert.ok(textContent.includes('screenshot.png'));
  });

  it('limits inline images to MAX_INLINE_IMAGES, prioritizing newest', () => {
    const makeImageMsg = (name: string, idx: number): GroupChatMessage => msg(name, `image ${idx}`, {
      id: `om_${300 + idx}`,
      createdAt: new Date(Date.now() + idx * 1000).toISOString(),
      attachments: [{
        kind: 'image',
        fileName: `img_${idx}.png`,
        mimeType: 'image/png',
        cloudinaryUrl: `https://res.cloudinary.com/demo/img_${idx}.png`,
        inlineContext: `[Image: "img_${idx}.png"\nOCR: content ${idx}]`,
        isInlineComplete: true,
        ingestionStatus: 'indexed',
      }],
    });

    // Create 12 image messages (more than MAX_INLINE_IMAGES=8)
    const recentMessages = Array.from({ length: 12 }, (_, i) => makeImageMsg('User', i));

    const window: GroupChatWindow = {
      summary: null,
      recentMessages,
      totalMessageCount: 12,
    };

    const result = formatGroupContextMultimodal(window);

    const imagePartsCount = result.parts.filter(p => p.type === 'image').length;
    assert.ok(imagePartsCount <= 8, `Expected at most 8 images, got ${imagePartsCount}`);
    assert.ok(result.hasImages);

    // Verify that the newest images are the ones included
    const imageUrls = result.parts
      .filter(p => p.type === 'image')
      .map(p => (p as { type: 'image'; url: string }).url);
    // Newest images should be included (higher indices)
    if (imageUrls.length > 0) {
      assert.ok(imageUrls.some(u => u.includes('img_11')), 'newest image should be included');
    }
  });

  it('includes OCR supplement alongside image parts', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'receipt', {
          id: 'om_400',
          attachments: [{
            kind: 'image',
            fileName: 'receipt.png',
            mimeType: 'image/png',
            cloudinaryUrl: 'https://res.cloudinary.com/demo/receipt.png',
            inlineContext: '[Image: "receipt.png"\nOCR text:\nTotal: $42.00]',
            isInlineComplete: true,
            ingestionStatus: 'indexed',
          }],
        }),
      ],
      totalMessageCount: 1,
    };

    const result = formatGroupContextMultimodal(window);

    // Find OCR supplement part following the image
    const imageParts = result.parts.map((p, i) => ({ ...p, idx: i })).filter(p => p.type === 'image');
    assert.equal(imageParts.length, 1);

    const nextPart = result.parts[imageParts[0]!.idx + 1];
    assert.ok(nextPart?.type === 'text');
    if (nextPart.type === 'text') {
      assert.ok(nextPart.text.includes('OCR supplement'));
      assert.ok(nextPart.text.includes('Total: $42.00'));
    }
  });

  it('includes rolling summary when present', () => {
    const summary: GroupChatSummary = {
      summary: 'Team discussed Q3 budget',
      activeEntities: [],
      completedActions: [],
      constraints: [],
      userGoals: [],
      sourceMessageCount: 10,
      updatedAt: new Date().toISOString(),
    };

    const window: GroupChatWindow = {
      summary,
      recentMessages: [msg('Alice', 'Hello')],
      totalMessageCount: 11,
    };

    const result = formatGroupContextMultimodal(window);

    const textContent = result.parts.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n');
    assert.ok(textContent.includes('ROLLING SUMMARY'));
    assert.ok(textContent.includes('Q3 budget'));
  });

  it('interleaves text and images in chronological order', () => {
    const window: GroupChatWindow = {
      summary: null,
      recentMessages: [
        msg('Alice', 'First message', { createdAt: '2026-05-14T09:00:00Z' }),
        msg('Bob', 'Image message', {
          id: 'om_500',
          createdAt: '2026-05-14T09:01:00Z',
          attachments: [{
            kind: 'image',
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            cloudinaryUrl: 'https://res.cloudinary.com/demo/photo.jpg',
            inlineContext: '[Image: "photo.jpg"\nOCR: text here]',
            isInlineComplete: true,
            ingestionStatus: 'indexed',
          }],
        }),
        msg('Alice', 'Third message', { createdAt: '2026-05-14T09:02:00Z' }),
      ],
      totalMessageCount: 3,
    };

    const result = formatGroupContextMultimodal(window);

    const types = result.parts.map(p => p.type);
    // Should be: text(RECENT), text(Alice msg1), text(Bob msg2), text(label), image, text(OCR), text(Alice msg3)
    const imageIdx = types.indexOf('image');
    assert.ok(imageIdx > 2, 'image should come after initial text parts');

    // Text after image should exist (Alice's third message)
    const textAfterImage = result.parts.slice(imageIdx + 1).filter(p => p.type === 'text');
    assert.ok(textAfterImage.length > 0);
    const hasThirdMsg = textAfterImage.some(p => p.type === 'text' && p.text.includes('Third message'));
    assert.ok(hasThirdMsg, 'Third message should appear after image');
  });
});
