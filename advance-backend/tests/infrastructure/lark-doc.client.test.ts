import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkDocClient } from '../../src/infrastructure/channels/lark/clients/lark-doc.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };
const DOC_TOKEN = 'doxcnABCDEF12345';

describe('LarkDocClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── getDoc ────────────────────────────────────────────────────────────────

  describe('getDoc', () => {
    it('GETs /docx/v1/documents/{id} and returns document object', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes(`/documents/${DOC_TOKEN}`),
          response: {
            code: 0,
            data: {
              document: { document_id: DOC_TOKEN, title: 'My Doc', revision_id: 3 },
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const doc = await client.getDoc(DOC_TOKEN) as Record<string, unknown>;

      assert.equal(doc['document_id'], DOC_TOKEN);
      assert.equal(doc['title'], 'My Doc');
    });

    it('throws LarkApiError when doc not found', async () => {
      globalThis.fetch = errorMock('document not found', 1069904);
      const client = new LarkDocClient(DEPS);
      await assert.rejects(() => client.getDoc('missing'), LarkApiError);
    });

    it('URL-encodes docToken', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { document: { document_id: 'x' } } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      await client.getDoc('doc/with/slashes');

      const apiCall = calls.find(c => c.url.includes('documents'));
      assert.ok(apiCall?.url.includes('doc%2Fwith%2Fslashes'), 'should URL-encode docToken');
    });
  });

  // ── createDoc ─────────────────────────────────────────────────────────────

  describe('createDoc', () => {
    it('POSTs to docs_ai documents and returns docToken', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.endsWith('/docs_ai/v1/documents'),
          response: { code: 0, data: { document: { document_id: 'new-doc-abc', title: 'Q1 Report' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const result = await client.createDoc('Q1 Report');

      assert.equal(result.docToken, 'new-doc-abc');
    });

    it('resolves doc URL from Drive metadata with with_url=true', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.endsWith('/docs_ai/v1/documents'),
          response: { code: 0, data: { document: { document_id: 'doc_url_1', title: 'Q1 Report' } } },
        },
        {
          match: (url, m) => m === 'POST' && url.includes('/drive/v1/metas/batch_query'),
          response: { code: 0, data: { metas: [{ doc_token: 'doc_url_1', doc_type: 'docx', url: 'https://tenant.larksuite.com/docx/doc_url_1' }] } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const result = await client.createDoc('Q1 Report');

      assert.equal(result.url, 'https://tenant.larksuite.com/docx/doc_url_1');
      assert.equal(result.docUrl, 'https://tenant.larksuite.com/docx/doc_url_1');
      const metaCall = calls.find(c => c.method === 'POST' && c.url.includes('/drive/v1/metas/batch_query'));
      assert.deepEqual(metaCall?.body, {
        request_docs: [{ doc_token: 'doc_url_1', doc_type: 'docx' }],
        with_url: true,
      });
    });

    it('sends title in request body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.endsWith('/docs_ai/v1/documents'),
          response: { code: 0, data: { document: { document_id: 'doc1' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      await client.createDoc('Strategic Plan');

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).endsWith('/docs_ai/v1/documents'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['content'], '<title>Strategic Plan</title>');
      assert.equal(body?.['format'], 'xml');
    });

    it('throws on API error', async () => {
      globalThis.fetch = errorMock('quota exceeded', 1069100);
      const client = new LarkDocClient(DEPS);
      await assert.rejects(() => client.createDoc('New Doc'), LarkApiError);
    });
  });

  // ── listBlocks ────────────────────────────────────────────────────────────

  describe('listBlocks', () => {
    it('GETs /documents/{id}/blocks and returns items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/blocks') && !url.includes('/children'),
          response: {
            code: 0,
            data: {
              items: [
                { block_id: 'b1', block_type: 2 },
                { block_id: 'b2', block_type: 3 },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const blocks = await client.listBlocks(DOC_TOKEN) as unknown[];

      assert.equal(blocks.length, 2);
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const blocks = await client.listBlocks(DOC_TOKEN);
      assert.deepEqual(blocks, []);
    });
  });

  // ── appendBlock ───────────────────────────────────────────────────────────

  describe('appendBlock', () => {
    it('GETs doc to find root block id, then POSTs children', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes(`/documents/${DOC_TOKEN}`) && !url.includes('/blocks'),
          response: { code: 0, data: { document: { document_id: DOC_TOKEN } } },
        },
        {
          match: (url, m) => m === 'POST' && url.includes('/children'),
          response: { code: 0, data: { children: [] } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      await client.appendBlock(DOC_TOKEN, 'Hello world');

      // Should have made 2 real API calls (GET doc + POST children) plus 1 token
      const apiCalls = calls.filter(c => !c.url.includes('tenant_access_token'));
      assert.equal(apiCalls.length, 2, 'should GET doc then POST children');

      const postCall = calls.find(c => c.method === 'POST' && c.url.includes('/children'));
      const body = postCall?.body as Record<string, unknown>;
      const children = body?.['children'] as unknown[];
      assert.equal(children?.length, 1, 'should post 1 block');
    });

    it('sends content text in the block body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && !url.includes('/blocks') && !url.includes('token'),
          response: { code: 0, data: { document: { document_id: DOC_TOKEN } } },
        },
        {
          match: (url, m) => m === 'POST' && url.includes('/children'),
          response: { code: 0, data: {} },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      await client.appendBlock(DOC_TOKEN, 'Important note');

      const postCall = calls.find(c => c.method === 'POST' && c.url.includes('/children'));
      const body = postCall?.body as Record<string, unknown>;
      const children = body?.['children'] as Array<Record<string, unknown>>;
      const block = children?.[0] as Record<string, unknown>;
      const text = block?.['text'] as Record<string, unknown>;
      const elements = text?.['elements'] as Array<Record<string, unknown>>;
      const textRun = elements?.[0]?.['text_run'] as Record<string, unknown>;
      assert.equal(textRun?.['content'], 'Important note');
    });
  });

  describe('createMarkdownDoc', () => {
    it('creates one markdown doc through docs_ai and keeps URL from response', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.endsWith('/docs_ai/v1/documents'),
          response: { code: 0, data: { document: { document_id: DOC_TOKEN, url: 'https://tenant.larksuite.com/docx/doc' } } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      const result = await client.createMarkdownDoc('Launch Plan', '# Launch Plan\n\n- Build\n- Ship\n\n```txt\ncode\n```');

      assert.equal(result.docToken, DOC_TOKEN);
      assert.equal(result.url, 'https://tenant.larksuite.com/docx/doc');
      const createCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/docs_ai/v1/documents'));
      const body = createCall?.body as Record<string, unknown>;
      assert.equal(body?.['format'], 'markdown');
      assert.match(String(body?.['content']), /^# Launch Plan/);
      assert.equal(calls.some(c => c.url.includes('/children')), false);
    });

    it('appends markdown through docs_ai block_insert_after at document end', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'PUT' && url.includes('/docs_ai/v1/documents/'),
          response: { code: 0, data: { result: 'success' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkDocClient(DEPS);
      await client.appendMarkdown(DOC_TOKEN, '## New Section\n\nBody');

      const updateCall = calls.find(c => c.method === 'PUT' && c.url.includes('/docs_ai/v1/documents/'));
      assert.deepEqual(updateCall?.body, {
        block_id: '-1',
        command: 'block_insert_after',
        content: '## New Section\n\nBody',
        format: 'markdown',
        revision_id: -1,
      });
    });
  });
});
