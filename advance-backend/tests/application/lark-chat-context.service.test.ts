import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LarkChatContextService,
  partitionRecentMessages,
} from '../../src/application/chat-context/lark-chat-context.service.ts';
import type { GroupChatMessage } from '../../src/domain/conversation/group-context.ts';
import { GROUP_CONTEXT_POLICY } from '../../src/domain/conversation/group-context-policy.ts';
import type {
  LarkChatContextRepoPort,
  LarkChatContextRow,
} from '../../src/infrastructure/persistence/lark-chat-context.repository.ts';
import type { InfraError } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { ok, type Result } from '../../src/shared/result.ts';
import type { LanguageModel } from 'ai';

function makeMsg(content: string): GroupChatMessage {
  return {
    id: `msg-${Math.random()}`,
    senderOpenId: 'ou_test',
    senderName: 'Test User',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    botMentioned: false,
  };
}

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return logger; },
};

class FakeLarkChatContextRepo implements LarkChatContextRepoPort {
  row: LarkChatContextRow = {
    id: 'ctx_1',
    companyId: 'company_1',
    chatId: 'chat_1',
    chatType: 'group',
    recentMessagesJson: [],
    summaryJson: null,
    sourceMessageCount: 0,
    lastMessageAt: null,
  };

  async getOrCreate(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }): Promise<Result<LarkChatContextRow, InfraError>> {
    this.row = {
      ...this.row,
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: input.chatType ?? this.row.chatType,
    };
    return ok(this.row);
  }

  async update(
    id: string,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<void, InfraError>> {
    this.row = {
      ...this.row,
      id,
      recentMessagesJson: data.recentMessagesJson,
      ...(data.summaryJson !== undefined ? { summaryJson: data.summaryJson } : {}),
      sourceMessageCount: data.sourceMessageCount,
      lastMessageAt: data.lastMessageAt,
    };
    return ok(undefined);
  }

  async clear(): Promise<Result<void, InfraError>> {
    this.row = {
      ...this.row,
      recentMessagesJson: [],
      summaryJson: null,
      sourceMessageCount: 0,
      lastMessageAt: null,
    };
    return ok(undefined);
  }
}

describe('partitionRecentMessages', () => {
  it('returns all messages when under min threshold', () => {
    const messages = Array.from({ length: 10 }, () => makeMsg('short'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(compactedChunk.length, 0);
    assert.equal(retained.length, 10);
  });

  it('retains minimum messages even when token budget exceeded', () => {
    const messages = Array.from({ length: 50 }, () => makeMsg('x'.repeat(10_000)));
    const { retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.ok(retained.length >= 40, `expected at least 40, got ${retained.length}`);
  });

  it('caps retained messages and returns overflow for summary rollover', () => {
    const messages = Array.from({ length: 250 }, () => makeMsg('short'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(retained.length, 200);
    assert.equal(compactedChunk.length, 50);
    assert.equal(compactedChunk.length + retained.length, 250);
  });

  it('compacts older messages when budget is exceeded beyond min', () => {
    const messages = Array.from({ length: 100 }, () => makeMsg('x'.repeat(5_000)));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.ok(compactedChunk.length > 0, 'should compact some older messages');
    assert.ok(retained.length >= 40, 'should retain at least min messages');
    assert.equal(compactedChunk.length + retained.length, 100);
  });

  it('returns empty compacted chunk when all fit within budget', () => {
    const messages = Array.from({ length: 50 }, () => makeMsg('hello'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(compactedChunk.length, 0);
    assert.equal(retained.length, 50);
  });

  it('uses the lean retention budget to roll older group messages into summary', () => {
    const messages = Array.from({ length: 100 }, () => makeMsg('x'.repeat(1_000)));
    const { compactedChunk, retained } = partitionRecentMessages(
      messages,
      GROUP_CONTEXT_POLICY.RETAINED_MESSAGE_TOKEN_BUDGET,
      GROUP_CONTEXT_POLICY.MIN_MESSAGES,
      GROUP_CONTEXT_POLICY.MAX_MESSAGES,
    );

    assert.ok(compactedChunk.length > 0);
    assert.ok(retained.length >= GROUP_CONTEXT_POLICY.MIN_MESSAGES);
    assert.equal(compactedChunk.length + retained.length, 100);
  });
});

describe('LarkChatContextService attachment snapshots', () => {
  it('uses Lark message IDs and merges attachment enrichment into the same message', async () => {
    const repo = new FakeLarkChatContextRepo();
    const service = new LarkChatContextService({
      repo,
      model: {} as LanguageModel,
      logger,
    });

    const first = await service.appendMessage({
      companyId: 'company_1',
      chatId: 'chat_1',
      chatType: 'group',
      messageId: 'om_1',
      senderOpenId: 'ou_user',
      senderName: 'Alice',
      role: 'user',
      content: 'Uploaded this invoice',
      createdAt: '2026-05-14T08:00:00.000Z',
      botMentioned: false,
      attachments: [{
        kind: 'file',
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        larkFileKey: 'file_key_1',
        larkMessageId: 'om_1',
        inlineContext: '[Document excerpt from "invoice.pdf":\nInvoice total $100]',
        isInlineComplete: false,
        ingestionStatus: 'processing',
      }],
    });

    assert.equal(first.ok, true);
    assert.equal(repo.row.sourceMessageCount, 1);
    assert.equal((repo.row.recentMessagesJson as GroupChatMessage[]).length, 1);

    const updated = await service.updateMessageAttachments({
      companyId: 'company_1',
      chatId: 'chat_1',
      messageId: 'om_1',
      attachments: [{
        kind: 'file',
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        larkFileKey: 'file_key_1',
        larkMessageId: 'om_1',
        fileAssetId: 'file_asset_1',
        ingestionStatus: 'indexed',
        indexedChunkCount: 4,
        retrievalHint: 'Use contextSearch or documentRag with fileAssetId="file_asset_1".',
      }],
    });

    assert.equal(updated.ok, true);
    const messages = repo.row.recentMessagesJson as GroupChatMessage[];
    assert.equal(messages.length, 1);
    assert.equal(repo.row.sourceMessageCount, 1);
    assert.equal(messages[0]!.id, 'om_1');
    assert.equal(messages[0]!.attachments?.[0]?.inlineContext?.includes('Invoice total $100'), true);
    assert.equal(messages[0]!.attachments?.[0]?.fileAssetId, 'file_asset_1');
    assert.equal(messages[0]!.attachments?.[0]?.ingestionStatus, 'indexed');
  });
});
