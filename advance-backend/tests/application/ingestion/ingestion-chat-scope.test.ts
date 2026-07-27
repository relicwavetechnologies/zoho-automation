/**
 * The link between "a file was uploaded into a Lark room" and "that room can
 * retrieve it".
 *
 * The scope key is written on the vector payload at ingestion and matched by
 * `buildScopeShould` at search time. Both halves already have tests; what has
 * no other guard is that the key actually survives the trip. If it does not,
 * nothing errors — the uploader keeps working, and every colleague's question
 * comes back empty.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IngestionService } from '../../../src/application/ingestion/ingestion.service.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { TypedEnv } from '../../../src/config/env.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const env = {
  DOC_EXTRACT_MAX_WORDS: 1000,
  FILE_RAG_CHUNK_SEARCH_ENABLED: false,
  FILE_RAG_MULTIMODAL_ENABLED: false,
  GEMINI_API_KEY: '',
  GOOGLE_GENERATIVE_AI_API_KEY: '',
} as unknown as TypedEnv;

/** Records the vectors handed to Qdrant; everything else is a no-op. */
function makeService() {
  const upserted: Array<Record<string, unknown>> = [];
  const service = new IngestionService(
    env,
    { uploadBuffer: async () => ({ publicId: 'p', secureUrl: 'https://cdn/x' }) } as never,
    { embedDocuments: async (chunks: unknown[]) => chunks.map(() => [0.1]) } as never,
    { upsertVectors: async (inputs: Array<Record<string, unknown>>) => { upserted.push(...inputs); } } as never,
    {
      create: async () => ({ ok: true, value: { id: 'fa-1' } }),
      setStatus: async () => {},
    } as never,
    { upsertMany: async () => {} } as never,
    { createMany: async () => {} } as never,
    noopLogger,
  );
  return { service, upserted };
}

const larkUpload = {
  companyId: 'co-1',
  uploaderUserId: 'u-1',
  uploaderChannel: 'lark',
  fileName: 'contract.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Clause 7 covers termination of the agreement.'),
};

describe('chat-scoped ingestion', () => {
  it('stamps the chat id on every chunk of a Lark upload', async () => {
    const { service, upserted } = makeService();

    await service.ingestBuffer({ ...larkUpload, larkChatId: 'oc_room' });

    assert.ok(upserted.length > 0, 'the document produced at least one chunk');
    for (const vector of upserted) {
      const payload = vector['payload'] as Record<string, unknown>;
      assert.equal(
        payload['larkChatId'], 'oc_room',
        'every chunk carries the scope key — one that does not is unreachable',
      );
    }
  });

  it('leaves the key off a desktop upload', async () => {
    // An absent key is what keeps desktop files out of the chat-scope branch.
    // Writing a placeholder such as an empty string would put them in it.
    const { service, upserted } = makeService();

    await service.ingestBuffer({ ...larkUpload, uploaderChannel: 'desktop' });

    for (const vector of upserted) {
      const payload = vector['payload'] as Record<string, unknown>;
      assert.equal('larkChatId' in payload, false);
    }
  });

  it('keeps the chat scope separate from company-wide visibility', async () => {
    // Posting in one room is not a decision to share with the company. The
    // room reaches the file through the scope key; `shared` would hand it to
    // everyone, including people who were never in the conversation.
    const { service, upserted } = makeService();

    await service.ingestBuffer({ ...larkUpload, larkChatId: 'oc_room' });

    assert.equal(upserted[0]?.['visibility'], 'personal');
    assert.equal(upserted[0]?.['ownerUserId'], 'u-1');
  });
});
