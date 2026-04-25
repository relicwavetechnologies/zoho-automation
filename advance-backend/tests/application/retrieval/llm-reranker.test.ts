import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LlmRerankerService } from '../../../src/application/retrieval/llm-reranker.service.ts';
import type { VectorSearchResult } from '../../../src/infrastructure/ai/vector/types.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function makeChunk(text: string, score: number, id = text.slice(0, 8)): VectorSearchResult {
  return {
    id,
    score,
    payload: { rawChunkText: text },
    collectionName: 'test',
  };
}

describe('LlmRerankerService — no API key', () => {
  it('falls back to score-sort when no API key provided', async () => {
    const svc = new LlmRerankerService(undefined, noopLogger, 3);
    const chunks = [
      makeChunk('least relevant', 0.3, 'c1'),
      makeChunk('most relevant', 0.9, 'c2'),
      makeChunk('middle', 0.6, 'c3'),
    ];
    const ranked = await svc.rerank('test query', chunks);
    assert.equal(ranked.length, 3);
    assert.equal(ranked[0]!.chunk.id, 'c2', 'highest score first');
    assert.equal(ranked[2]!.chunk.id, 'c1', 'lowest score last');
  });

  it('returns empty when given empty chunks', async () => {
    const svc = new LlmRerankerService(undefined, noopLogger, 3);
    const ranked = await svc.rerank('query', []);
    assert.equal(ranked.length, 0);
  });

  it('rerankerScore is chunk score * 10 in fallback', async () => {
    const svc = new LlmRerankerService(undefined, noopLogger, 3);
    const chunks = [makeChunk('text', 0.75, 'c1')];
    const ranked = await svc.rerank('query', chunks);
    assert.equal(ranked[0]!.rerankerScore, 7.5);
  });
});

describe('LlmRerankerService — with API key (mocked Groq)', () => {
  it('parses valid Groq response and sorts by score', async () => {
    const svc = new LlmRerankerService('fake-key', noopLogger, 3);

    // Stub the internal Groq client's completions.create
    const chunks = [
      makeChunk('chapter about leave policy', 0.5, 'c1'),
      makeChunk('irrelevant text about dogs', 0.8, 'c2'),
      makeChunk('refund and cancellation policy section', 0.6, 'c3'),
    ];

    // Directly monkey-patch the private client field
    (svc as unknown as Record<string, unknown>)['client'] = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '[8, 1, 9]' } }],
          }),
        },
      },
    };

    const ranked = await svc.rerank('refund policy', chunks);
    assert.ok(ranked.length >= 1, 'should return ranked results');
    assert.equal(ranked[0]!.chunk.id, 'c3', 'highest score (9) should be first');
    assert.equal(ranked[0]!.rerankerScore, 9);
    assert.ok(!ranked.find(r => r.chunk.id === 'c2'), 'score=1 should be filtered by threshold=3');
  });

  it('falls back to score-sort on invalid JSON from Groq', async () => {
    const svc = new LlmRerankerService('fake-key', noopLogger, 3);
    const chunks = [makeChunk('text', 0.5, 'c1'), makeChunk('other', 0.8, 'c2')];

    (svc as unknown as Record<string, unknown>)['client'] = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'not json' } }],
          }),
        },
      },
    };

    const ranked = await svc.rerank('query', chunks);
    assert.equal(ranked.length, 2, 'fallback should include all chunks');
    assert.equal(ranked[0]!.chunk.id, 'c2', 'fallback sorts by score desc');
  });

  it('falls back when Groq returns wrong array length', async () => {
    const svc = new LlmRerankerService('fake-key', noopLogger, 3);
    const chunks = [makeChunk('text1', 0.5, 'c1'), makeChunk('text2', 0.7, 'c2')];

    (svc as unknown as Record<string, unknown>)['client'] = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '[8]' } }], // only 1 score for 2 chunks
          }),
        },
      },
    };

    const ranked = await svc.rerank('query', chunks);
    assert.equal(ranked.length, 2, 'fallback should include all chunks');
  });
});
