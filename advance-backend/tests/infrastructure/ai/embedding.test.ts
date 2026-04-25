/**
 * Tests for the embedding infrastructure:
 *   A. FallbackEmbeddingProvider   — deterministic vectors, zero-vector for empty, analyzeMedia
 *   B. EmbeddingService            — batching, per-batch fallback, multimodal delegation
 *   C. deterministicVector         — stable across calls, correct dimension, normalization
 *
 * No real OpenAI / Gemini calls are made. Provider is always injected as a mock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FallbackEmbeddingProvider,
  deterministicVector,
} from '../../../src/infrastructure/ai/embedding/fallback.provider.ts';
import { EmbeddingService } from '../../../src/infrastructure/ai/embedding/embedding.service.ts';
import type {
  EmbeddingProvider,
  EmbeddingDocumentInput,
  MediaAnalysisInput,
} from '../../../src/infrastructure/ai/embedding/types.ts';
import type { Logger } from '../../../src/shared/logger.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

function makeService(provider: EmbeddingProvider, batchSize = 16): EmbeddingService {
  return new EmbeddingService({ provider, logger: noopLogger, batchSize });
}

/** Build a mock provider that returns `[index / 100, ...]`-style vectors. */
function mockProvider(opts: {
  dimension?: number;
  failOnCallIndex?: number; // throw on nth call to embedDocuments/embedQueries
  returnCount?: number;     // return this many vectors regardless of input length (for mismatch test)
}): EmbeddingProvider & {
  calls: { method: string; inputs: unknown[] }[];
} {
  const dim = opts.dimension ?? 1536;
  let callCount = 0;

  const calls: { method: string; inputs: unknown[] }[] = [];

  return {
    provider: 'openai',
    textDimension: dim,
    multimodalDimension: dim,
    calls,

    async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
      calls.push({ method: 'embedDocuments', inputs });
      if (opts.failOnCallIndex !== undefined && callCount++ === opts.failOnCallIndex) {
        throw new Error('mock embedDocuments failure');
      }
      const count = opts.returnCount ?? inputs.length;
      return Array.from({ length: count }, (_, i) => Array.from({ length: dim }, () => i / 100));
    },

    async embedQueries(texts: string[]): Promise<number[][]> {
      calls.push({ method: 'embedQueries', inputs: texts });
      if (opts.failOnCallIndex !== undefined && callCount++ === opts.failOnCallIndex) {
        throw new Error('mock embedQueries failure');
      }
      return texts.map((_, i) => Array.from({ length: dim }, () => i / 100));
    },
  };
}

// ─── A. deterministicVector ───────────────────────────────────────────────────

describe('deterministicVector', () => {
  it('produces a vector of the requested dimension', () => {
    const v = deterministicVector('hello world', 1536);
    assert.equal(v.length, 1536);
  });

  it('returns a zero vector for empty string', () => {
    const v = deterministicVector('', 64);
    assert.ok(v.every(x => x === 0));
  });

  it('returns a zero vector for whitespace-only string', () => {
    const v = deterministicVector('   ', 64);
    assert.ok(v.every(x => x === 0));
  });

  it('is stable across multiple calls with the same input', () => {
    const a = deterministicVector('test input', 128);
    const b = deterministicVector('test input', 128);
    assert.deepEqual(a, b);
  });

  it('produces different vectors for different inputs', () => {
    const a = deterministicVector('hello', 128);
    const b = deterministicVector('world', 128);
    assert.notDeepEqual(a, b);
  });

  it('all values are in [0, 1]', () => {
    const v = deterministicVector('some text', 256);
    assert.ok(v.every(x => x >= 0 && x <= 1));
  });

  it('normalises internal whitespace (multiple spaces → one)', () => {
    const a = deterministicVector('hello   world', 64);
    const b = deterministicVector('hello world', 64);
    assert.deepEqual(a, b);
  });
});

// ─── B. FallbackEmbeddingProvider ─────────────────────────────────────────────

describe('FallbackEmbeddingProvider', () => {
  const fallback = new FallbackEmbeddingProvider();

  it('has provider = "fallback"', () => {
    assert.equal(fallback.provider, 'fallback');
  });

  it('textDimension = multimodalDimension = 1536', () => {
    assert.equal(fallback.textDimension, 1536);
    assert.equal(fallback.multimodalDimension, 1536);
  });

  it('embedDocuments returns one vector per input', async () => {
    const vectors = await fallback.embedDocuments([
      { text: 'alpha', title: 'A' },
      { text: 'beta' },
    ]);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, 1536);
    assert.equal(vectors[1].length, 1536);
  });

  it('embedDocuments vectors differ for different content', async () => {
    const [a, b] = await fallback.embedDocuments([
      { text: 'first text' },
      { text: 'second text' },
    ]);
    assert.notDeepEqual(a, b);
  });

  it('embedDocuments is stable (same input → same vector)', async () => {
    const [a] = await fallback.embedDocuments([{ text: 'stable', title: 'T' }]);
    const [b] = await fallback.embedDocuments([{ text: 'stable', title: 'T' }]);
    assert.deepEqual(a, b);
  });

  it('embedDocuments returns empty array for empty input', async () => {
    const v = await fallback.embedDocuments([]);
    assert.deepEqual(v, []);
  });

  it('embedQueries returns one vector per text', async () => {
    const vectors = await fallback.embedQueries(['query one', 'query two', 'query three']);
    assert.equal(vectors.length, 3);
    vectors.forEach(v => assert.equal(v.length, 1536));
  });

  it('embedMultimodal delegates to embedDocuments', async () => {
    const mV = await fallback.embedMultimodal!([{ text: 'image caption' }]);
    const dV = await fallback.embedDocuments([{ text: 'image caption' }]);
    assert.deepEqual(mV, dV);
  });

  it('analyzeMedia returns correct modality for image mime type', async () => {
    const result = await fallback.analyzeMedia!({
      mimeType: 'image/png',
      fileName: 'photo.png',
      buffer: Buffer.from('fake'),
    });
    assert.equal(result.modality, 'image');
    assert.ok(result.summary.includes('photo.png'));
  });

  it('analyzeMedia returns correct modality for video mime type', async () => {
    const result = await fallback.analyzeMedia!({
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      buffer: Buffer.from('fake'),
    });
    assert.equal(result.modality, 'video');
  });

  it('analyzeMedia includes cloudinaryUrl in summary when provided', async () => {
    const result = await fallback.analyzeMedia!({
      mimeType: 'image/jpeg',
      fileName: 'img.jpg',
      buffer: Buffer.from('x'),
      cloudinaryUrl: 'https://cdn.example.com/img.jpg',
    });
    assert.ok(result.summary.includes('https://cdn.example.com/img.jpg'));
  });
});

// ─── C. EmbeddingService ──────────────────────────────────────────────────────

describe('EmbeddingService', () => {
  it('exposes providerName and dimension from the provider', () => {
    const svc = makeService(mockProvider({ dimension: 3072 }));
    assert.equal(svc.providerName, 'openai');
    assert.equal(svc.dimension, 3072);
    assert.equal(svc.multimodalDimension, 3072);
  });

  it('embedDocuments passes inputs to provider and returns vectors', async () => {
    const provider = mockProvider({});
    const svc = makeService(provider);
    const vectors = await svc.embedDocuments([
      { text: 'hello', title: 'H' },
      'world',
    ]);
    assert.equal(vectors.length, 2);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].method, 'embedDocuments');
  });

  it('embedDocuments accepts plain strings (normalised to {text})', async () => {
    const provider = mockProvider({});
    const svc = makeService(provider);
    await svc.embedDocuments(['a', 'b', 'c']);
    const call = provider.calls[0];
    assert.deepEqual(call.inputs, [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  });

  it('embedDocuments returns empty array for empty input', async () => {
    const svc = makeService(mockProvider({}));
    const v = await svc.embedDocuments([]);
    assert.deepEqual(v, []);
  });

  it('batches large inputs according to batchSize', async () => {
    const provider = mockProvider({});
    const svc = makeService(provider, 3); // batchSize = 3
    await svc.embedDocuments(['a', 'b', 'c', 'd', 'e']); // 5 inputs → 2 batches
    assert.equal(provider.calls.length, 2);
    assert.equal((provider.calls[0].inputs as unknown[]).length, 3);
    assert.equal((provider.calls[1].inputs as unknown[]).length, 2);
  });

  it('falls back to deterministic vector when a batch fails', async () => {
    // failOnCallIndex=0 → first batch throws, should be replaced by fallback vectors
    const provider = mockProvider({ failOnCallIndex: 0 });
    const svc = makeService(provider, 10);
    // Should NOT throw — fallback kicks in
    const vectors = await svc.embedDocuments([{ text: 'test' }]);
    assert.equal(vectors.length, 1);
    assert.equal(vectors[0].length, 1536);
    // Verify it's the deterministic fallback (compare with known SHA-256 output)
    const expected = deterministicVector('test', 1536);
    assert.deepEqual(vectors[0], expected);
  });

  it('succeeds on second batch when first batch fails', async () => {
    // batchSize=1 → two batches; first fails, second succeeds
    const provider = mockProvider({ failOnCallIndex: 0 });
    const svc = makeService(provider, 1);
    const vectors = await svc.embedDocuments([{ text: 'A' }, { text: 'B' }]);
    assert.equal(vectors.length, 2);
    // first vector: deterministic fallback
    assert.deepEqual(vectors[0], deterministicVector('A', 1536));
    // second vector: from mock (0/100 × dim)
    assert.deepEqual(vectors[1], Array.from({ length: 1536 }, () => 0));
  });

  it('embedQueries delegates to provider.embedQueries', async () => {
    const provider = mockProvider({});
    const svc = makeService(provider);
    const vectors = await svc.embedQueries(['q1', 'q2']);
    assert.equal(vectors.length, 2);
    assert.equal(provider.calls[0].method, 'embedQueries');
  });

  it('embedQuery returns a single vector', async () => {
    const svc = makeService(mockProvider({}));
    const vec = await svc.embedQuery('single query');
    assert.ok(Array.isArray(vec));
    assert.equal(vec.length, 1536);
  });

  it('embedText is an alias for embedDocuments', async () => {
    const provider = mockProvider({});
    const svc = makeService(provider);
    await svc.embedText(['x', 'y']);
    assert.equal(provider.calls[0].method, 'embedDocuments');
  });

  it('embedMultimodal calls provider.embedMultimodal when available', async () => {
    // Build a provider that has embedMultimodal
    const dim = 3072;
    const multimodalCalls: unknown[][] = [];
    const provider: EmbeddingProvider = {
      provider: 'gemini',
      textDimension: dim,
      multimodalDimension: dim,
      async embedDocuments() { return []; },
      async embedQueries()  { return []; },
      async embedMultimodal(inputs) {
        multimodalCalls.push(inputs);
        return inputs.map(() => Array.from({ length: dim }, () => 0.5));
      },
    };
    const svc = makeService(provider);
    const vectors = await svc.embedMultimodal([{ text: 'caption' }]);
    assert.equal(vectors.length, 1);
    assert.equal(multimodalCalls.length, 1);
  });

  it('embedMultimodal falls back to embedDocuments when provider has no embedMultimodal', async () => {
    const provider = mockProvider({}); // no embedMultimodal
    const svc = makeService(provider);
    await svc.embedMultimodal([{ text: 'test' }]);
    assert.equal(provider.calls[0].method, 'embedDocuments');
  });

  it('analyzeMedia throws when provider does not support it', async () => {
    const svc = makeService(mockProvider({}));
    const mediaInput: MediaAnalysisInput = {
      mimeType: 'image/png',
      fileName: 'img.png',
      buffer: Buffer.from('x'),
    };
    await assert.rejects(
      () => svc.analyzeMedia(mediaInput),
      /does not support media analysis/,
    );
  });

  it('analyzeMedia delegates to provider.analyzeMedia when available', async () => {
    const fallback = new FallbackEmbeddingProvider();
    const svc = makeService(fallback);
    const result = await svc.analyzeMedia({
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      buffer: Buffer.from('fake'),
    });
    assert.equal(result.modality, 'image');
  });

  it('embedMediaSummary returns analysis + embedding', async () => {
    const fallback = new FallbackEmbeddingProvider();
    const svc = makeService(fallback);
    const result = await svc.embedMediaSummary({
      mimeType: 'image/png',
      fileName: 'test.png',
      buffer: Buffer.from('data'),
    });
    assert.ok(typeof result.summary === 'string');
    assert.ok(Array.isArray(result.embedding));
    assert.equal(result.embedding.length, 1536);
    assert.equal(result.modality, 'image');
  });

  it('modalityForMimeType returns correct modality', () => {
    const svc = makeService(mockProvider({}));
    assert.equal(svc.modalityForMimeType('image/png'),  'image');
    assert.equal(svc.modalityForMimeType('video/mp4'),  'video');
    assert.equal(svc.modalityForMimeType('text/plain'), 'text');
    assert.equal(svc.modalityForMimeType('application/pdf'), 'text');
  });

  it('provider mismatch (too few vectors) triggers fallback for that batch', async () => {
    // returnCount=0 means provider returns 0 vectors for any batch size → mismatch
    const provider = mockProvider({ returnCount: 0 });
    const svc = makeService(provider, 2);
    const vectors = await svc.embedDocuments([{ text: 'x' }, { text: 'y' }]);
    // Should fall back to deterministic vectors
    assert.equal(vectors.length, 2);
    assert.deepEqual(vectors[0], deterministicVector('x', 1536));
    assert.deepEqual(vectors[1], deterministicVector('y', 1536));
  });
});
