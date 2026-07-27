/**
 * Access control on the document-RAG read paths.
 *
 * `readFull` resolves a document by id alone, and ids travel: they are written
 * into Lark transcripts as retrieval hints, so anyone who has seen one can
 * quote it back later — from another company, or after leaving the room the
 * file was posted in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocumentRagBroker } from '../../../src/application/retrieval/document-rag.broker.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { TypedEnv } from '../../../src/config/env.ts';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const env = {
  RAG_FULL_READ_MAX_CHARS: 10_000,
  FILE_RAG_REWRITE_ENABLED: false,
  FILE_RAG_GRADING_ENABLED: false,
  OPENAI_API_KEY: '',
} as unknown as TypedEnv;

const asset = (companyId: string, uploaderUserId = 'u-1') => ({
  id: 'fa-1', companyId, uploaderUserId, fileName: 'contract.pdf',
  mimeType: 'application/pdf', cloudinaryUrl: 'https://cdn/contract.pdf',
});

function makeBroker(over: { assetCompanyId?: string; captureQuery?: (q: unknown) => void } = {}) {
  return new DocumentRagBroker(
    env,
    {
      search: async (query: unknown) => { over.captureQuery?.(query); return []; },
    } as never,
    { embedQueries: async () => [[0.1]] } as never,
    { rerank: async () => [] } as never,
    {
      findById: async () => ({ ok: true, value: asset(over.assetCompanyId ?? 'co-1') }),
    } as never,
    { findByFileAsset: async () => ({ ok: true, value: [{ chunkIndex: 0, chunkText: 'secret clause', payload: {} }] }) } as never,
    noopLogger,
  );
}

describe('documentRag readFull — ownership', () => {
  it('reads back a document the requester uploaded themselves', async () => {
    const doc = await makeBroker({ assetCompanyId: 'co-1' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-1', requesterUserId: 'u-1',
    });

    assert.ok(doc, 'the owning company can read it');
    assert.match(doc.text, /secret clause/);
  });

  it('refuses a document belonging to another company', async () => {
    // The failure this prevents: a fileAssetId copied out of a transcript is
    // enough to read another tenant's file in full. companyId was accepted as
    // a parameter and then never compared to anything.
    const doc = await makeBroker({ assetCompanyId: 'co-1' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-2', requesterUserId: 'u-9',
    });

    assert.equal(doc, null);
  });

  it('checks ownership before reading any bytes', async () => {
    // Order matters: resolving the chunks first and filtering after would
    // still pull the other company's text into this process.
    let chunksRead = false;
    const broker = new DocumentRagBroker(
      env,
      { search: async () => [] } as never,
      { embedQueries: async () => [[0.1]] } as never,
      { rerank: async () => [] } as never,
      { findById: async () => ({ ok: true, value: asset('co-1') }) } as never,
      {
        findByFileAsset: async () => {
          chunksRead = true;
          return { ok: true, value: [] };
        },
      } as never,
      noopLogger,
    );

    await broker.readFull({ fileAssetId: 'fa-1', companyId: 'co-2', requesterUserId: 'u-9' });

    assert.equal(chunksRead, false, 'the denied read never touched the chunk store');
  });
});

describe('documentRag readFull — room scope', () => {
  /** An asset uploaded by u-insider, indexed against Lark room oc_room. */
  function brokerFor(chunkPayload: Record<string, unknown>) {
    return new DocumentRagBroker(
      env,
      { search: async () => [] } as never,
      { embedQueries: async () => [[0.1]] } as never,
      { rerank: async () => [] } as never,
      {
        findById: async () => ({
          ok: true,
          value: { ...asset('co-1'), uploaderUserId: 'u-insider' },
        }),
      } as never,
      {
        findByFileAsset: async () => ({
          ok: true,
          value: [{ chunkIndex: 0, chunkText: 'CEO base salary', payload: chunkPayload }],
        }),
      } as never,
      noopLogger,
    );
  }

  it('lets a colleague read it from the room it was posted in', async () => {
    const doc = await brokerFor({ larkChatId: 'oc_room' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-1',
      requesterUserId: 'u-colleague', larkChatId: 'oc_room',
    });

    assert.ok(doc, 'the room can read its own document');
  });

  it('refuses the same colleague asking from a different chat', async () => {
    // The precise failure: an id copied out of a room transcript, replayed
    // later from a DM or another room, returned the whole document.
    const doc = await brokerFor({ larkChatId: 'oc_room' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-1',
      requesterUserId: 'u-colleague', larkChatId: 'oc_elsewhere',
    });

    assert.equal(doc, null);
  });

  it('refuses a colleague with no chat scope at all', async () => {
    // Desktop and scheduled runs supply no Lark chat, so they must not reach
    // a room-scoped document.
    const doc = await brokerFor({ larkChatId: 'oc_room' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-1', requesterUserId: 'u-colleague',
    });

    assert.equal(doc, null);
  });

  it('still lets the uploader read their own file from anywhere', async () => {
    const doc = await brokerFor({ larkChatId: 'oc_room' }).readFull({
      fileAssetId: 'fa-1', companyId: 'co-1', requesterUserId: 'u-insider',
    });

    assert.ok(doc, 'the uploader is not locked out of their own document');
  });
});

describe('documentRag search — scope', () => {
  it('identifies the requester, so personal files are reachable at all', async () => {
    // `buildScopeShould` drops the personal branch entirely when
    // requesterUserId is absent. Omitting it made every personal file
    // invisible to documentRag — including every document uploaded via Lark.
    let query: any;
    await makeBroker({ captureQuery: q => { query = q; } }).search({
      query: 'termination clause',
      companyId: 'co-1', requesterUserId: 'u-1', requesterAiRole: 'MEMBER',
    });

    assert.equal(query.requesterUserId, 'u-1');
    assert.equal(query.companyId, 'co-1');
  });

  it('carries the Lark chat scope when one is supplied', async () => {
    let query: any;
    await makeBroker({ captureQuery: q => { query = q; } }).search({
      query: 'termination clause',
      companyId: 'co-1', requesterUserId: 'u-1', requesterAiRole: 'MEMBER',
      larkChatId: 'oc_room',
    });

    assert.equal(query.larkChatId, 'oc_room');
  });

  it('leaves the chat scope unset outside Lark', async () => {
    let query: any;
    await makeBroker({ captureQuery: q => { query = q; } }).search({
      query: 'termination clause',
      companyId: 'co-1', requesterUserId: 'u-1', requesterAiRole: 'MEMBER',
    });

    assert.equal(query.larkChatId, undefined);
  });
});
