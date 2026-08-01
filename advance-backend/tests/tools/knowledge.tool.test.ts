import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKnowledgeTool } from '../../src/application/tools/families/knowledge.tool.ts';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';

const resourceId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';

function tool(overrides: Record<string, unknown> = {}) {
  return createKnowledgeTool({
    mutations: {} as any,
    projections: {} as any,
    recall: {} as any,
    resources: {
      list: async () => [{
        resourceId,
        kind: 'file' as const,
        scope: 'personal' as const,
        logicalKey: 'files.weekly-template',
        currentVersion: 2,
        title: 'weekly-template.docx',
        summary: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document, 1200 bytes',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }],
      get: async () => ({
        resourceId,
        kind: 'file' as const,
        scope: 'personal' as const,
        logicalKey: 'files.weekly-template',
        currentVersion: 2,
        title: 'weekly-template.docx',
        summary: 'document',
        updatedAt: '2026-07-31T00:00:00.000Z',
        content: {
          assetId,
          fileName: 'weekly-template.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 1200,
          sha256: 'a'.repeat(64),
        },
      }),
    } as any,
    files: {
      createDownload: async () => ({
        url: 'https://files.example.test/signed',
        fileName: 'weekly-template.docx',
        expiresInSeconds: 300,
      }),
    } as any,
    documents: {
      search: async () => ({ status: 'available' as const, results: [] }),
    } as any,
    ...overrides,
  });
}

describe('knowledge tool canonical resource reads', () => {
  it('classifies catalogue and download operations as read-only', () => {
    const instance = tool();
    const permission = makeAllowedPerm('knowledge', ['read']);
    for (const args of [
      { operation: 'resources.list' as const },
      { operation: 'resources.get' as const, resourceId },
      { operation: 'files.download' as const, resourceId },
      { operation: 'documents.search' as const, query: 'weekly report procedure' },
    ]) {
      const checked = instance.permissionCheck(args, permission);
      assert.equal(checked.ok, true);
      assert.equal(checked.ok && checked.value, 'read');
    }
  });

  it('returns canonical current-version metadata without resource content in list results', async () => {
    const result = await tool().execute(
      { operation: 'resources.list', kind: 'file', query: 'weekly' },
      makeCtx('knowledge', ['read']),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.resources[0]?.currentVersion, 2);
    assert.equal(result.ok && 'content' in result.value.resources[0]!, false);
  });

  it('downloads only the current authorized file and never returns its internal asset ID', async () => {
    let receivedAssetId: string | undefined;
    const instance = tool({
      files: {
        createDownload: async (input: any) => {
          receivedAssetId = input.assetId;
          return {
            url: 'https://files.example.test/signed',
            fileName: 'weekly-template.docx',
            expiresInSeconds: 300,
          };
        },
      },
    });
    const result = await instance.execute(
      { operation: 'files.download', resourceId },
      makeCtx('knowledge', ['read']),
    );
    assert.equal(result.ok, true);
    assert.equal(receivedAssetId, assetId);
    assert.equal(result.ok && result.value.resourceId, resourceId);
    assert.equal(result.ok && 'assetId' in result.value, false);
  });

  it('passes only authenticated identity to document search and returns bounded human provenance', async () => {
    let received: Record<string, unknown> | undefined;
    const instance = tool({
      documents: {
        search: async (input: Record<string, unknown>) => {
          received = input;
          return {
            status: 'available' as const,
            results: [{
              resourceId,
              scope: 'department' as const,
              fileName: 'release.pdf',
              excerpt: 'Rollback must happen before Owners.',
              pageStart: 7,
              pageEnd: 7,
              sectionPath: ['Release', 'Rollback'],
              department: { name: 'Tech Testing' },
            }],
          };
        },
      },
    });

    const result = await instance.execute(
      { operation: 'documents.search', query: 'rollback owners' },
      makeCtx('knowledge', ['read']),
    );

    assert.equal(result.ok, true);
    assert.equal(received?.['query'], 'rollback owners');
    assert.equal(received?.['departmentId'], undefined);
    assert.equal(received?.['companyId'], 'co-test');
    assert.equal(received?.['userId'], 'user-test');
    assert.deepEqual(result.ok && result.value.results[0], {
      resourceId,
      scope: 'department',
      fileName: 'release.pdf',
      excerpt: 'Rollback must happen before Owners.',
      pageStart: 7,
      pageEnd: 7,
      sectionPath: ['Release', 'Rollback'],
      department: { name: 'Tech Testing' },
    });
  });
});
