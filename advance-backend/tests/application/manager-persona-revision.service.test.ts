import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ManagerPersonaRevisionError,
  ManagerPersonaRevisionService,
} from '../../src/application/persona-learning/manager-persona-revision.service';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

describe('ManagerPersonaRevisionService', () => {
  it('retains only two previous snapshots', async () => {
    const revisions: any[] = [];
    let currentRevision = 1;
    const tx: any = {
      managerPersonaTree: {
        findUnique: async () => ({ id: 'tree-1', revision: currentRevision, nodes: [] }),
      },
      managerPersonaRevision: {
        upsert: async ({ create }: any) => {
          const existing = revisions.find(row => row.revision === create.revision);
          if (!existing) revisions.push({ id: `history-${create.revision}`, createdAt: new Date(currentRevision * 1_000), ...create });
        },
        findMany: async ({ skip }: any) => [...revisions]
          .sort((a, b) => b.revision - a.revision)
          .slice(skip)
          .map(row => ({ id: row.id })),
        deleteMany: async ({ where }: any) => {
          const ids = new Set(where.id.in);
          for (let index = revisions.length - 1; index >= 0; index -= 1) {
            if (ids.has(revisions[index].id)) revisions.splice(index, 1);
          }
        },
      },
    };
    const service = new ManagerPersonaRevisionService({ prisma: {} as never, logger: noopLogger });

    await service.captureBeforeMutation(tx, 'tree-1', 'teach');
    currentRevision = 2;
    await service.captureBeforeMutation(tx, 'tree-1', 'teach');
    currentRevision = 3;
    await service.captureBeforeMutation(tx, 'tree-1', 'teach');

    assert.deepEqual(revisions.map(row => row.revision).sort(), [2, 3]);
  });

  it('supports exactly two consecutive Undo operations', async () => {
    let treeRevision = 3;
    const revisions: any[] = [
      { id: 'history-1', treeId: 'tree-1', revision: 1, snapshotJson: { nodes: [] }, createdAt: new Date(1_000) },
      { id: 'history-2', treeId: 'tree-1', revision: 2, snapshotJson: { nodes: [] }, createdAt: new Date(2_000) },
    ];
    const tx: any = {
      managerPersonaTree: {
        findUnique: async () => ({ id: 'tree-1', revision: treeRevision }),
        update: async () => ({ revision: ++treeRevision }),
      },
      managerPersonaRevision: {
        findFirst: async () => [...revisions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
        delete: async ({ where }: any) => {
          revisions.splice(revisions.findIndex(row => row.id === where.id), 1);
        },
        count: async () => revisions.length,
      },
      managerPersonaNode: { deleteMany: async () => ({ count: 0 }), create: async () => ({ id: 'unused' }) },
      personaLearningCandidate: { updateMany: async () => ({ count: 0 }) },
    };
    const prisma = {
      departmentMembership: { findFirst: async () => ({ id: 'membership-1' }) },
      $transaction: async (fn: any) => fn(tx),
    };
    const service = new ManagerPersonaRevisionService({ prisma: prisma as never, logger: noopLogger });
    const input = { companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1' };

    assert.equal((await service.undo(input)).remainingUndos, 1);
    assert.equal((await service.undo(input)).remainingUndos, 0);
    await assert.rejects(
      service.undo(input),
      (error: unknown) => error instanceof ManagerPersonaRevisionError && error.code === 'no_undo_available',
    );
  });
});
