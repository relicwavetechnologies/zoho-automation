import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnowledgeFileService,
  type KnowledgeFileAssetRepository,
  type KnowledgePrivateObjectStore,
  type ReadableKnowledgeFile,
  type StagedKnowledgeFile,
} from '../../src/application/knowledge/knowledge-file.service.ts';
import { KnowledgeMutationError } from '../../src/application/knowledge/knowledge-mutation.errors.ts';
import type { Logger } from '../../src/shared/logger.ts';

const identity = {
  companyId: 'co-1',
  userId: 'user-a',
  companyRole: 'MEMBER',
  channel: 'desktop' as const,
};

const validPdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

const logger: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

class FakeAssets implements KnowledgeFileAssetRepository {
  readonly rows = new Map<string, ReadableKnowledgeFile>();
  departmentMember = false;

  async create(input: Omit<StagedKnowledgeFile, 'knowledgeResourceId' | 'status'>) {
    const row: ReadableKnowledgeFile = {
      ...input,
      knowledgeResourceId: null,
      status: 'staged',
      isCurrentVersion: false,
      resource: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getForValidation(input: { assetId: string; companyId: string }) {
    const row = this.rows.get(input.assetId);
    return row?.companyId === input.companyId ? row : null;
  }

  async getForAccess(input: { assetId: string; companyId: string }) {
    const row = this.rows.get(input.assetId);
    return row?.companyId === input.companyId ? row : null;
  }

  async isActiveDepartmentMember() { return this.departmentMember; }

  async claimStagedDeletion(input: { assetId: string; companyId: string; uploadedById: string }) {
    const row = this.rows.get(input.assetId);
    if (
      !row
      || row.companyId !== input.companyId
      || row.uploadedById !== input.uploadedById
      || row.status !== 'staged'
      || row.knowledgeResourceId
    ) return null;
    const deleting: ReadableKnowledgeFile = { ...row, status: 'deleting' };
    this.rows.set(row.id, deleting);
    return deleting;
  }

  async completeStagedDeletion(input: { assetId: string; companyId: string }) {
    const row = this.rows.get(input.assetId);
    if (!row || row.companyId !== input.companyId || row.status !== 'deleting' || row.knowledgeResourceId) return false;
    this.rows.set(row.id, { ...row, status: 'deleted' });
    return true;
  }

  async releaseStagedDeletion(input: { assetId: string; companyId: string }) {
    const row = this.rows.get(input.assetId);
    if (!row || row.companyId !== input.companyId || row.status !== 'deleting' || row.knowledgeResourceId) return false;
    this.rows.set(row.id, { ...row, status: 'staged' });
    return true;
  }

  async claimExpired(input: { now: Date; staleDeletionBefore: Date }) {
    return [...this.rows.values()].filter(row =>
      !row.knowledgeResourceId
      && ((row.status === 'staged' && row.expiresAt <= input.now)
        || (row.status === 'deleting' && row.expiresAt <= input.staleDeletionBefore)),
    ).map(row => {
      const claimed: ReadableKnowledgeFile = { ...row, status: 'deleting' };
      this.rows.set(row.id, claimed);
      return claimed;
    });
  }

  async listDeletableForResource(input: { companyId: string; resourceId: string }) {
    return [...this.rows.values()].filter(row =>
      row.companyId === input.companyId
      && row.knowledgeResourceId === input.resourceId
      && (row.status === 'attached' || row.status === 'deleting'),
    );
  }

  async claimAttachedDeletion(input: { assetId: string; companyId: string; resourceId: string }) {
    const row = this.rows.get(input.assetId);
    if (
      !row
      || row.companyId !== input.companyId
      || row.knowledgeResourceId !== input.resourceId
      || (row.status !== 'attached' && row.status !== 'deleting')
    ) return null;
    const claimed: ReadableKnowledgeFile = { ...row, status: 'deleting' };
    this.rows.set(row.id, claimed);
    return claimed;
  }

  async completeAttachedDeletion(input: { assetId: string; companyId: string; resourceId: string }) {
    const row = this.rows.get(input.assetId);
    if (!row || row.companyId !== input.companyId || row.knowledgeResourceId !== input.resourceId || row.status !== 'deleting') return false;
    this.rows.set(row.id, { ...row, status: 'deleted' });
    return true;
  }

  async releaseAttachedDeletion(input: { assetId: string; companyId: string; resourceId: string }) {
    const row = this.rows.get(input.assetId);
    if (!row || row.companyId !== input.companyId || row.knowledgeResourceId !== input.resourceId || row.status !== 'deleting') return false;
    this.rows.set(row.id, { ...row, status: 'attached' });
    return true;
  }
}

class FakeObjects implements KnowledgePrivateObjectStore {
  readonly provider = 'fake';
  isAvailable = true;
  uploaded: string[] = [];
  deleted: string[] = [];
  failDeleteStorageKey: string | null = null;

  async upload(input: { buffer: Buffer; assetId: string }) {
    this.uploaded.push(input.assetId);
    return {
      storageKey: `knowledge_files/co-1/${input.assetId}`,
      resourceType: 'raw',
      deliveryType: 'authenticated' as const,
      bytes: input.buffer.length,
    };
  }

  signedDownloadUrl(input: { storageKey: string }) { return `https://private.test/${input.storageKey}`; }

  async read() { return validPdf(); }

  async delete(input: { storageKey: string }) {
    if (input.storageKey === this.failDeleteStorageKey) throw new Error('object deletion failed');
    this.deleted.push(input.storageKey);
  }
}

function service(assets = new FakeAssets(), objects = new FakeObjects()) {
  return {
    assets,
    objects,
    files: new KnowledgeFileService({
      assets,
      objects,
      permissions: { canInvoke: async () => ({ ok: true, value: true as const }) },
      logger,
      maxBytes: 1_024,
      stagingTtlMs: 60_000,
    }),
  };
}

function securedService(scan: 'clean' | 'infected' | 'unavailable') {
  const assets = new FakeAssets();
  const objects = new FakeObjects();
  return {
    objects,
    files: new KnowledgeFileService({
      assets,
      objects,
      permissions: { canInvoke: async () => ({ ok: true, value: true as const }) },
      logger,
      maxBytes: 1_024,
      stagingTtlMs: 60_000,
      threatScanRequired: true,
      threatScanner: scan === 'unavailable' ? null : {
        scan: async () => scan === 'clean'
          ? { status: 'clean' as const, provider: 'test-scanner', engineVersion: '1' }
          : { status: 'infected' as const, provider: 'test-scanner', threat: 'EICAR-Test' },
      },
    }),
  };
}

describe('KnowledgeFileService', () => {
  it('stages only private allowed files and returns no provider storage key', async () => {
    const { files, assets, objects } = service();
    const result = await files.stage({
      identity,
      fileName: '../procedure.pdf',
      mimeType: 'application/pdf',
      buffer: validPdf(),
    });
    assert.equal(result.fileName, '.._procedure.pdf');
    assert.equal(result.sha256.length, 64);
    assert.equal('storageKey' in result, false);
    assert.equal(objects.uploaded.length, 1);
    assert.equal(assets.rows.get(result.id)?.deliveryType, 'authenticated');

    await assert.rejects(files.stage({
      identity,
      fileName: 'script.sh',
      mimeType: 'application/x-sh',
      buffer: Buffer.from('echo unsafe'),
    }), (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'invalid_request');
  });

  it('fails closed before upload without a required clean malware verdict', async () => {
    for (const verdict of ['infected', 'unavailable'] as const) {
      const { files, objects } = securedService(verdict);
      await assert.rejects(files.stage({
        identity,
        fileName: 'procedure.pdf',
        mimeType: 'application/pdf',
        buffer: validPdf(),
      }), (error: unknown) => error instanceof KnowledgeMutationError
        && (verdict === 'infected' ? error.code === 'invalid_request' : error.code === 'storage_failure'));
      assert.equal(objects.uploaded.length, 0);
    }
  });

  it('persists the scanner evidence only after a clean verdict', async () => {
    const { files, objects } = securedService('clean');
    const staged = await files.stage({
      identity,
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      buffer: validPdf(),
    });
    assert.equal(objects.uploaded.length, 1);
    assert.equal(staged.fileName, 'procedure.pdf');
  });

  it('authorizes downloads from the live governed scope instead of the asset ID alone', async () => {
    const { files, assets } = service();
    const staged = await files.stage({
      identity,
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      buffer: validPdf(),
    });
    const own = await files.createDownload({ identity, assetId: staged.id });
    assert.match(own.url, /^https:\/\/private\.test\//);

    const row = assets.rows.get(staged.id)!;
    assets.rows.set(staged.id, {
      ...row,
      status: 'attached',
      knowledgeResourceId: 'resource-1',
      isCurrentVersion: true,
      resource: {
        companyId: 'co-1',
        scope: 'department',
        ownerUserId: null,
        departmentId: 'dept-1',
        status: 'active',
      },
    });
    await assert.rejects(files.createDownload({
      identity: { ...identity, userId: 'user-b' },
      assetId: staged.id,
    }), (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'permission_denied');
    assets.departmentMember = true;
    const member = await files.createDownload({
      identity: { ...identity, userId: 'user-b' },
      assetId: staged.id,
    });
    assert.equal(member.fileName, 'procedure.pdf');

    assets.rows.set(staged.id, {
      ...assets.rows.get(staged.id)!,
      isCurrentVersion: false,
    });
    await assert.rejects(files.createDownload({
      identity: { ...identity, userId: 'user-b' },
      assetId: staged.id,
    }), (error: unknown) => error instanceof KnowledgeMutationError && error.code === 'permission_denied');
  });

  it('lets only the uploader discard an unattached staged file', async () => {
    const { files, objects } = service();
    const staged = await files.stage({
      identity,
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      buffer: validPdf(),
    });
    assert.equal(await files.discardStaged({
      identity: { ...identity, userId: 'user-b' },
      assetId: staged.id,
    }), false);
    assert.equal(await files.discardStaged({ identity, assetId: staged.id }), true);
    assert.equal(objects.deleted.length, 1);
  });

  it('releases a staged deletion for a safe retry when object deletion fails', async () => {
    const { files, assets, objects } = service();
    const staged = await files.stage({
      identity, fileName: 'procedure.pdf', mimeType: 'application/pdf', buffer: validPdf(),
    });
    objects.failDeleteStorageKey = assets.rows.get(staged.id)!.storageKey;

    await assert.rejects(files.discardStaged({ identity, assetId: staged.id }), /object deletion failed/);
    assert.equal(assets.rows.get(staged.id)?.status, 'staged');
    objects.failDeleteStorageKey = null;
    assert.equal(await files.discardStaged({ identity, assetId: staged.id }), true);
    assert.equal(assets.rows.get(staged.id)?.status, 'deleted');
  });

  it('purges only files attached to an approved deleted resource', async () => {
    const { files, assets, objects } = service();
    const target = await files.stage({
      identity, fileName: 'target.pdf', mimeType: 'application/pdf', buffer: validPdf(),
    });
    const other = await files.stage({
      identity, fileName: 'other.pdf', mimeType: 'application/pdf', buffer: validPdf(),
    });
    const targetRow = assets.rows.get(target.id)!;
    const otherRow = assets.rows.get(other.id)!;
    assets.rows.set(target.id, {
      ...targetRow, status: 'attached', knowledgeResourceId: 'resource-target', isCurrentVersion: true,
    });
    assets.rows.set(other.id, {
      ...otherRow, status: 'attached', knowledgeResourceId: 'resource-other', isCurrentVersion: true,
    });

    assert.equal(await files.purgeResource({ companyId: 'co-1', resourceId: 'resource-target' }), 1);
    assert.equal(assets.rows.get(target.id)?.status, 'deleted');
    assert.equal(assets.rows.get(other.id)?.status, 'attached');
    assert.deepEqual(objects.deleted, [targetRow.storageKey]);
  });

  it('does not mark an attached file deleted when private object deletion fails', async () => {
    const { files, assets, objects } = service();
    const staged = await files.stage({
      identity, fileName: 'target.pdf', mimeType: 'application/pdf', buffer: validPdf(),
    });
    const row = assets.rows.get(staged.id)!;
    assets.rows.set(staged.id, {
      ...row, status: 'attached', knowledgeResourceId: 'resource-target', isCurrentVersion: true,
    });
    objects.failDeleteStorageKey = row.storageKey;

    await assert.rejects(
      files.purgeResource({ companyId: 'co-1', resourceId: 'resource-target' }),
      /object deletion failed/,
    );
    assert.equal(assets.rows.get(staged.id)?.status, 'attached');
  });
});
