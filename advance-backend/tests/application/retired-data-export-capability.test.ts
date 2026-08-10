import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retireDataExportCapability } from '../../src/application/skills/retired-data-export-capability';

describe('retireDataExportCapability', () => {
  it('removes the retired tool everywhere and invalidates every affected skill catalogue', async () => {
    let affectedSkillWhere: unknown;
    const updates: unknown[] = [];
    const deletions: Array<{ model: string; args: unknown }> = [];
    const revisions: unknown[] = [];
    const tx = {
      skill: {
        findMany: async ({ where }: any) => {
          if (where?.isSystem === true) {
            return [{ id: 'retired-system', companyId: 'company-b' }];
          }
          affectedSkillWhere = where;
          return [
            {
              id: 'system-router',
              companyId: 'company-a',
              isSystem: true,
              toolIds: ['dataExport', 'zohoBooks'],
            },
            {
              id: 'custom-recipe',
              companyId: 'company-b',
              isSystem: false,
              toolIds: ['dataExport'],
            },
          ];
        },
        update: async (args: unknown) => {
          updates.push(args);
          return {};
        },
        deleteMany: async (args: unknown) => {
          deletions.push({ model: 'skill', args });
          return { count: 1 };
        },
      },
      skillCapability: deleteRecorder('skillCapability', deletions),
      departmentUserToolOverride: deleteRecorder('departmentUserToolOverride', deletions),
      departmentToolPermission: deleteRecorder('departmentToolPermission', deletions),
      toolActionPermission: deleteRecorder('toolActionPermission', deletions),
      toolPermission: deleteRecorder('toolPermission', deletions),
      companyCapabilityGovernance: deleteRecorder('companyCapabilityGovernance', deletions),
      connectionAuthorizationIntent: deleteRecorder('connectionAuthorizationIntent', deletions),
      registeredTool: {
        deleteMany: async (args: unknown) => {
          deletions.push({ model: 'registeredTool', args });
          return { count: 1 };
        },
      },
      skillRegistryRevision: {
        upsert: async (args: unknown) => {
          revisions.push(args);
          return {};
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    };

    const result = await retireDataExportCapability(prisma as any);

    assert.deepEqual(affectedSkillWhere, {
      OR: [
        { toolIds: { has: 'dataExport' } },
        {
          isSystem: false,
          status: { not: 'archived' },
          OR: [
            { markdown: { contains: 'dataExport', mode: 'insensitive' } },
            { markdown: { contains: 'secure-data-export', mode: 'insensitive' } },
            { markdown: { contains: 'exportCandidate', mode: 'insensitive' } },
          ],
        },
      ],
    });

    assert.deepEqual(updates, [
      {
        where: { id: 'system-router' },
        data: { toolIds: ['zohoBooks'], revision: { increment: 1 } },
      },
      {
        where: { id: 'custom-recipe' },
        data: { toolIds: [], status: 'archived', revision: { increment: 1 } },
      },
    ]);
    assert.deepEqual(new Set(deletions.map(entry => entry.model)), new Set([
      'skill',
      'skillCapability',
      'departmentUserToolOverride',
      'departmentToolPermission',
      'toolActionPermission',
      'toolPermission',
      'companyCapabilityGovernance',
      'connectionAuthorizationIntent',
      'registeredTool',
    ]));
    assert.deepEqual(
      revisions.map((entry: any) => entry.where.companyId).sort(),
      ['company-a', 'company-b'],
    );
    assert.deepEqual(result, {
      registeredToolsDeleted: 1,
      systemSkillsDeleted: 1,
      skillsRewritten: 2,
      companiesInvalidated: 2,
    });
  });
});

function deleteRecorder(
  model: string,
  deletions: Array<{ model: string; args: unknown }>,
) {
  return {
    deleteMany: async (args: unknown) => {
      deletions.push({ model, args });
      return { count: 1 };
    },
  };
}
