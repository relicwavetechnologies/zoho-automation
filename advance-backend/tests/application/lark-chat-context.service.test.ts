import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LarkChatContextService,
  partitionRecentMessages,
} from '../../src/application/chat-context/lark-chat-context.service.ts';
import type { GroupChatMessage, GroupChatSummary } from '../../src/domain/conversation/group-context.ts';
import { GROUP_CONTEXT_POLICY } from '../../src/domain/conversation/group-context-policy.ts';
import type {
  LarkChatContextRepoPort,
  LarkChatContextRow,
} from '../../src/infrastructure/persistence/lark-chat-context.repository.ts';
import type { InfraError } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { ok, type Result } from '../../src/shared/result.ts';
import type { LanguageModel } from 'ai';
import { textModel } from '../helpers/mock-model.ts';

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
    updatedAt: new Date('2026-05-14T00:00:00.000Z'),
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

  async get(input: {
    companyId: string;
    chatId: string;
  }): Promise<Result<LarkChatContextRow | null, InfraError>> {
    if (this.row.companyId !== input.companyId || this.row.chatId !== input.chatId) {
      return ok(null);
    }
    return ok(this.row);
  }

  async update(
    id: string,
    expectedUpdatedAt: Date,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<boolean, InfraError>> {
    if (this.row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      return ok(false);
    }
    this.row = {
      ...this.row,
      id,
      recentMessagesJson: data.recentMessagesJson,
      ...(data.summaryJson !== undefined ? { summaryJson: data.summaryJson } : {}),
      sourceMessageCount: data.sourceMessageCount,
      lastMessageAt: data.lastMessageAt,
      updatedAt: new Date(this.row.updatedAt.getTime() + 1),
    };
    return ok(true);
  }

  async clear(): Promise<Result<void, InfraError>> {
    this.row = {
      ...this.row,
      recentMessagesJson: [],
      summaryJson: null,
      sourceMessageCount: 0,
      lastMessageAt: null,
      updatedAt: new Date(this.row.updatedAt.getTime() + 1),
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
      resolveModel: async () => ({} as LanguageModel), modelId: 'deepseek-v4-flash',
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
        ingestionStatus: 'unsupported',
        inlineContext: 'Divo could not open this file, so it was not read.',
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
        ingestionStatus: 'workspace',
      }],
    });

    assert.equal(updated.ok, true);
    const messages = repo.row.recentMessagesJson as GroupChatMessage[];
    assert.equal(messages.length, 1);
    assert.equal(repo.row.sourceMessageCount, 1);
    assert.equal(messages[0]!.id, 'om_1');
    // A later status wins over the earlier one — the same upload is not
    // duplicated, and it stops being reported as refused once it lands.
    assert.equal(messages[0]!.attachments?.length, 1);
    assert.equal(messages[0]!.attachments?.[0]?.ingestionStatus, 'workspace');
  });
});

describe('LarkChatContextService rolling summary', () => {
  it('uses the fast model when older messages roll out of the protected tail', async () => {
    const repo = new FakeLarkChatContextRepo();
    repo.row.recentMessagesJson = Array.from({ length: 40 }, (_, index) => ({
      ...makeMsg(`Older discussion ${index}: ${'x'.repeat(2_500)}`),
      id: `om_${index}`,
      createdAt: new Date(Date.UTC(2026, 4, 14, 8, 0, index)).toISOString(),
    }));
    repo.row.summaryJson = {
      summary: 'Previous compacted discussion',
      activeEntities: [],
      decisions: ['Keep the signed-off budget'],
      owners: ['Alice owns close'],
      mentionedResources: ['prior-report.xlsx'],
      completedActions: [],
      constraints: [],
      userGoals: [],
      sourceMessageCount: 40,
      updatedAt: '2026-05-14T07:59:00.000Z',
    };
    repo.row.sourceMessageCount = 40;

    let calls = 0;
    const model = textModel(JSON.stringify({
      summary: 'Fast-model compacted discussion',
      latestObjective: 'Keep the newest room messages raw',
      decisions: [],
      owners: [],
      mentionedResources: [],
    })) as any;
    const doGenerate = model.doGenerate;
    model.doGenerate = async (input: any) => {
      calls++;
      return doGenerate(input);
    };

    const service = new LarkChatContextService({
      repo,
      resolveModel: async () => model,
      modelId: 'deepseek-v4-flash',
      logger,
    });
    const result = await service.appendMessage({
      companyId: 'company_1',
      chatId: 'chat_1',
      chatType: 'group',
      messageId: 'om_40',
      senderOpenId: 'ou_user',
      senderName: 'Alice',
      role: 'user',
      content: `Newest discussion: ${'y'.repeat(2_500)}`,
      createdAt: '2026-05-14T08:01:00.000Z',
      botMentioned: false,
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal((repo.row.summaryJson as GroupChatSummary).summary, 'Fast-model compacted discussion');
    assert.equal((repo.row.summaryJson as GroupChatSummary).sourceMessageCount, 41);
    assert.deepEqual((repo.row.summaryJson as GroupChatSummary).decisions, ['Keep the signed-off budget']);
    assert.deepEqual((repo.row.summaryJson as GroupChatSummary).owners, ['Alice owns close']);
    assert.deepEqual((repo.row.summaryJson as GroupChatSummary).mentionedResources, ['prior-report.xlsx']);
    assert.equal((repo.row.recentMessagesJson as GroupChatMessage[]).at(-1)?.id, 'om_40');
  });

  it('retries overlapping room writes so both messages survive', async () => {
    const repo = new FakeLarkChatContextRepo();
    const service = new LarkChatContextService({ repo, logger });

    const append = (messageId: string) => service.appendMessage({
      companyId: 'company_1',
      chatId: 'chat_1',
      chatType: 'group',
      messageId,
      senderOpenId: 'ou_user',
      senderName: 'Alice',
      role: 'user',
      content: `Message ${messageId}`,
      createdAt: '2026-05-14T08:01:00.000Z',
      botMentioned: false,
    });

    const [first, second] = await Promise.all([append('om_a'), append('om_b')]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(
      (repo.row.recentMessagesJson as GroupChatMessage[]).map(message => message.id).sort(),
      ['om_a', 'om_b'],
    );
  });

  it('keeps late attachment enrichment after its raw message was compacted', async () => {
    const repo = new FakeLarkChatContextRepo();
    const messages = Array.from({ length: 40 }, (_, index) => ({
      ...makeMsg(`Older discussion ${index}: ${'x'.repeat(2_500)}`),
      id: `om_${index}`,
      createdAt: new Date(Date.UTC(2026, 4, 14, 8, 0, index)).toISOString(),
    }));
    messages[0] = {
      ...messages[0]!,
      attachments: [{
        kind: 'file',
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        ingestionStatus: 'processing',
      }],
    };
    repo.row.recentMessagesJson = messages;
    repo.row.sourceMessageCount = 40;

    const service = new LarkChatContextService({
      repo,
      resolveModel: async () => (textModel(JSON.stringify({ summary: 'Older room discussion' }))), modelId: 'deepseek-v4-flash',
      logger,
    });
    await service.appendMessage({
      companyId: 'company_1',
      chatId: 'chat_1',
      chatType: 'group',
      messageId: 'om_40',
      senderOpenId: 'ou_user',
      senderName: 'Alice',
      role: 'user',
      content: `Newest discussion: ${'y'.repeat(2_500)}`,
      createdAt: '2026-05-14T08:01:00.000Z',
      botMentioned: false,
    });
    assert.equal(
      (repo.row.recentMessagesJson as GroupChatMessage[]).some(message => message.id === 'om_0'),
      false,
    );

    const updated = await service.updateMessageAttachments({
      companyId: 'company_1',
      chatId: 'chat_1',
      messageId: 'om_0',
      attachments: [{
        kind: 'file',
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        ingestionStatus: 'workspace',
      }],
    });

    assert.equal(updated.ok, true);
    // The message itself has rolled out of the transcript, so the filename is
    // the only trace left of it — without that, the file becomes unfindable.
    const resources = (repo.row.summaryJson as GroupChatSummary).mentionedResources ?? [];
    assert.ok(resources.includes('invoice.pdf'));
  });
});
