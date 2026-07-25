import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSummarizer } from '../../src/application/orchestration/engine/conversation-summarizer.ts';
import type { ConversationRepoPort, ConversationMeta } from '../../src/infrastructure/persistence/conversation.repository.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { ok } from '../../src/shared/result.ts';
import { HISTORY_POLICY } from '../../src/domain/conversation/history-policy.ts';

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function makeCache(lockAcquired = true): CachePort {
  return {
    get: async () => ok(null),
    set: async () => ok(undefined),
    setNx: async () => ok(lockAcquired),
    del: async () => ok(undefined),
    scanDel: async () => ok(0),
  };
}

function makeRepo(meta: ConversationMeta | null, turns: Array<{ id: string; role: string; content: string; timestamp: string }> = []): ConversationRepoPort {
  return {
    getHistory: async () => ok([]),
    appendTurn: async () => ok(undefined),
    clearChatHistories: async () => ok(0),
    getConversationMeta: async () => ok(meta),
    updateSummary: mock.fn(async () => ok(undefined)),
    getHistoryAfterSequence: async () => ok(turns as any),
  } as any;
}

function makeFakeModel() {
  return {
    doGenerate: async () => ({
      text: JSON.stringify({
        facts: ['User asked about invoices'],
        decisions: ['Will check overdue ones'],
        entities: ['Acme Corp'],
        activeWork: ['Review invoices'],
        toolsUsed: ['zohoBooks'],
      }),
      rawCall: { rawPrompt: '', rawSettings: {} },
    }),
    specificationVersion: 'v1' as const,
    provider: 'test',
    modelId: 'test',
    defaultObjectGenerationMode: undefined,
  } as any;
}

describe('ConversationSummarizer', () => {
  it('skips when lock cannot be acquired', async () => {
    const repo = makeRepo({ id: 'conv-1', summaryJson: null, lastSummarizedSequence: 0, lastMessageSequence: 30 });
    const summarizer = new ConversationSummarizer({
      conversationRepo: repo,
      model: makeFakeModel(),
      cache: makeCache(false),
      logger: noopLogger,
    });

    await summarizer.maybeSummarize('chat-1');
    const updateFn = repo.updateSummary as ReturnType<typeof mock.fn>;
    assert.equal(updateFn.mock.calls.length, 0);
  });

  it('skips when conversation has too few turns', async () => {
    const repo = makeRepo({
      id: 'conv-1',
      summaryJson: null,
      lastSummarizedSequence: 0,
      lastMessageSequence: 5,
    });
    const summarizer = new ConversationSummarizer({
      conversationRepo: repo,
      model: makeFakeModel(),
      cache: makeCache(true),
      logger: noopLogger,
    });

    await summarizer.maybeSummarize('chat-1');
    const updateFn = repo.updateSummary as ReturnType<typeof mock.fn>;
    assert.equal(updateFn.mock.calls.length, 0);
  });

  it('skips when estimated tokens are below soft threshold', async () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'Short message',
      timestamp: new Date().toISOString(),
    }));

    const repo = makeRepo(
      { id: 'conv-1', summaryJson: null, lastSummarizedSequence: 0, lastMessageSequence: 20 },
      turns,
    );
    const summarizer = new ConversationSummarizer({
      conversationRepo: repo,
      model: makeFakeModel(),
      cache: makeCache(true),
      logger: noopLogger,
    });

    await summarizer.maybeSummarize('chat-1');
    const updateFn = repo.updateSummary as ReturnType<typeof mock.fn>;
    assert.equal(updateFn.mock.calls.length, 0, 'Should not summarize below token threshold');
  });

  it('does not throw when LLM call fails', async () => {
    const bigContent = 'x'.repeat(HISTORY_POLICY.SUMMARIZATION_SOFT_THRESHOLD * 5);
    const turns = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: bigContent,
      timestamp: new Date().toISOString(),
    }));

    const badModel = {
      doGenerate: async () => { throw new Error('LLM timeout'); },
      specificationVersion: 'v1' as const,
      provider: 'test',
      modelId: 'test',
      defaultObjectGenerationMode: undefined,
    } as any;

    const repo = makeRepo(
      { id: 'conv-1', summaryJson: null, lastSummarizedSequence: 0, lastMessageSequence: 20 },
      turns,
    );
    const summarizer = new ConversationSummarizer({
      conversationRepo: repo,
      model: badModel,
      cache: makeCache(true),
      logger: noopLogger,
    });

    await assert.doesNotReject(() => summarizer.maybeSummarize('chat-1'));
  });
});
