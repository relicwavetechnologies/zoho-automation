import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactGmailMcpResult,
  compactGmailText,
  GMAIL_RESULT_LIMITS,
} from '../../src/infrastructure/google/gmail-result-compactor';
import { GoogleWorkspaceGatewayClient } from '../../src/infrastructure/google/google-workspace-gateway.client';

describe('Gmail model-facing result compaction', () => {
  it('independently clips one pathological message before aggregate limiting', () => {
    const source = [
      'Subject: Huge message',
      'From: sender@example.com',
      '',
      `Opening context ${'x'.repeat(30_000)} closing context`,
    ].join('\n');

    const result = compactGmailText('get_gmail_message_content', {}, source);

    assert.equal(result.text.length, GMAIL_RESULT_LIMITS.maxCharactersPerMessage);
    assert.match(result.text, /12000-character per-message limit/);
    assert.match(result.text, /Subject: Huge message/);
    assert.match(result.text, /closing context/);
    assert.equal(result.metadata.clippedMessages, 1);
    assert.equal(result.metadata.clippedThreads, 0);
    assert.equal(result.metadata.originalMessages, 1);
    assert.equal(result.metadata.returnedMessages, 1);
    assert.equal(result.metadata.omittedMessages, 0);
    assert.ok(result.metadata.reasons.includes('message_character_limit'));
    assert.equal(result.metadata.reasons.includes('character_limit'), false);
  });

  it('independently clips one pathological thread before aggregate limiting', () => {
    const messages = Array.from({ length: 4 }, (_, index) => [
      `=== Message ${index + 1} ===`,
      `From: sender-${index}@example.com`,
      '',
      `Message ${index + 1} ${'y'.repeat(10_900)}`,
      '',
    ].join('\n')).join('');
    const source = [
      'Thread ID: huge-thread',
      'Subject: Huge thread',
      'Messages: 4',
      '',
      messages,
    ].join('\n');

    const result = compactGmailText('get_gmail_thread_content', {}, source);

    assert.equal(result.text.length, GMAIL_RESULT_LIMITS.maxCharactersPerThread);
    assert.match(result.text, /40000-character per-thread limit/);
    assert.match(result.text, /Thread ID: huge-thread/);
    assert.match(result.text, /Message 4/);
    assert.equal(result.metadata.clippedMessages, 0);
    assert.equal(result.metadata.clippedThreads, 1);
    assert.equal(result.metadata.originalMessages, 4);
    assert.equal(
      result.metadata.omittedMessages,
      4 - result.metadata.returnedMessages,
    );
    assert.ok(result.metadata.reasons.includes('thread_character_limit'));
    assert.equal(result.metadata.reasons.includes('character_limit'), false);
  });

  it('bounds the traced multi-thread shape and reports every omitted message truthfully', () => {
    const threads = Array.from({ length: 6 }, (_, threadIndex) => {
      const messages = Array.from({ length: 7 }, (_, messageIndex) => [
        `=== Message ${messageIndex + 1} ===`,
        `From: sender-${messageIndex}@example.com`,
        `Date: 2026-07-${String(messageIndex + 1).padStart(2, '0')}`,
        '',
        `Current reply ${'x'.repeat(12_000)}`,
        '',
        'On Tue, someone wrote:',
        '> duplicated earlier reply',
        '> another duplicated line',
        '',
      ].join('\n')).join('');
      return [
        `Thread ID: thread-${threadIndex}`,
        `Subject: Subject ${threadIndex}`,
        'Messages: 7',
        '',
        messages,
      ].join('\n');
    });
    const source = `Retrieved 6 threads:\n\n${threads.join('\n---\n\n')}`;

    const result = compactGmailMcpResult(
      'get_gmail_threads_content_batch',
      { thread_ids: threads.map((_, index) => `thread-${index}`) },
      { text: source },
    ) as { text: string; _divoResult: Record<string, unknown> };

    assert.ok(result.text.length <= GMAIL_RESULT_LIMITS.maxCharacters);
    assert.ok((result.text.match(/^=== Message \d+ ===$/gm) ?? []).length <= GMAIL_RESULT_LIMITS.maxMessages);
    assert.equal(result._divoResult['originalMessages'], 42);
    assert.ok(Number(result._divoResult['returnedMessages']) <= GMAIL_RESULT_LIMITS.maxMessages);
    assert.equal(
      result._divoResult['omittedMessages'],
      42 - Number(result._divoResult['returnedMessages']),
    );
    assert.equal(result._divoResult['truncated'], true);
    assert.ok((result._divoResult['reasons'] as string[]).includes('quoted_replies'));
    assert.equal(result._divoResult['clippedMessages'], 42);
    assert.equal(result._divoResult['clippedThreads'], 6);
    assert.ok((result._divoResult['reasons'] as string[]).includes('message_character_limit'));
    assert.ok((result._divoResult['reasons'] as string[]).includes('thread_character_limit'));
    assert.ok((result._divoResult['reasons'] as string[]).includes('character_limit'));
  });

  it('strips only a trailing quoted reply block from plaintext', () => {
    const source = [
      'Subject: Update',
      '',
      'My current answer.',
      '',
      'On Tue, Pat wrote:',
      '> Old answer one',
      '> Old answer two',
    ].join('\n');

    const stripped = compactGmailText('get_gmail_message_content', {}, source);
    assert.match(stripped.text, /My current answer/);
    assert.doesNotMatch(stripped.text, /Old answer one/);
    assert.equal(stripped.metadata.quotedReplyCharactersRemoved > 0, true);

    const quotedExcerptWithNewText = `${source}\n\nMy conclusion after the excerpt.`;
    const preserved = compactGmailText('get_gmail_message_content', {}, quotedExcerptWithNewText);
    assert.match(preserved.text, /Old answer one/);
    assert.equal(preserved.metadata.quotedReplyCharactersRemoved, 0);

    const tinyQuote = compactGmailText(
      'get_gmail_message_content',
      {},
      'Current reply\n> a\n> b',
    );
    assert.equal(tinyQuote.text, 'Current reply\n> a\n> b');
    assert.equal(tinyQuote.metadata.truncated, false);

    const legitimatePassage = [
      'Useful source excerpt:',
      `> ${'A'.repeat(120)}`,
      `> ${'B'.repeat(120)}`,
      `> ${'C'.repeat(120)}`,
    ].join('\n');
    const unattributed = compactGmailText('get_gmail_message_content', {}, legitimatePassage);
    assert.equal(unattributed.text, legitimatePassage);
    assert.equal(unattributed.metadata.truncated, false);
    assert.equal(unattributed.metadata.quotedReplyCharactersRemoved, 0);
  });

  it('honors the pinned MCP metadata-only batch contract without quote stripping', () => {
    const source = [
      'Message ID: message-1',
      'Subject: Metadata only',
      'From: sender@example.com',
      '> header-like value one',
      '> header-like value two',
    ].join('\n');

    const result = compactGmailText(
      'get_gmail_messages_content_batch',
      { format: 'metadata' },
      source,
    );

    assert.equal(result.text, source);
    assert.equal(result.metadata.mode, 'metadata');
    assert.equal(result.metadata.truncated, false);
    assert.equal(result.metadata.quotedReplyCharactersRemoved, 0);
  });

  it('wires compaction after the MCP call while forwarding metadata-only input unchanged', async () => {
    const calls: Array<{ name: string; input: Readonly<Record<string, unknown>> }> = [];
    const input = { message_ids: ['message-1'], format: 'metadata' } as const;
    const client = new GoogleWorkspaceGatewayClient(
      'access-token',
      {
        describeTool: async () => null,
        callTool: async (name: string, forwarded: Readonly<Record<string, unknown>>) => {
          calls.push({ name, input: forwarded });
          return { text: 'Message ID: message-1\nSubject: Metadata only' };
        },
      } as never,
      {
        describeTool: () => null,
        callTool: async () => { throw new Error('unexpected Sheets adapter call'); },
      } as never,
    );

    const result = await client.callTool('get_gmail_messages_content_batch', input) as {
      text: string;
      _divoResult: { mode: string; truncated: boolean };
    };

    assert.deepEqual(calls, [{ name: 'get_gmail_messages_content_batch', input }]);
    assert.equal(result._divoResult.mode, 'metadata');
    assert.equal(result._divoResult.truncated, false);
  });
});
