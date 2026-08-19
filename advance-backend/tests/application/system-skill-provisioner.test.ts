import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SystemSkillDefinition } from '../../src/application/skills/system-skill-definition.ts';
import {
  buildSystemSkill,
  provisionSystemSkill,
} from '../../src/application/skills/system-skill-provisioner.ts';

const DEFINITION: SystemSkillDefinition = {
  slug: 'example-skill',
  name: 'Example',
  summary: 'Example summary',
  markdown: '# Example',
  toolIds: ['exampleTool'],
  tags: ['example'],
  aliases: ['example alias'],
  sortOrder: 1,
};

const PLACEMENT = {
  folderId: 'folder-1',
  departmentId: null,
  scope: 'company' as const,
  granteeType: 'company' as const,
  granteeId: 'company-1',
};

function rowFrom(
  data: ReturnType<typeof buildSystemSkill>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...data,
    revision: 1,
    createdBy: null,
    updatedBy: null,
    aliases: (DEFINITION.aliases ?? []).map((alias) => ({ alias })),
    ...overrides,
  };
}

describe('system skill provisioner', () => {
  it('revives an archived system skill when the deterministic id collides', async () => {
    const archived = rowFrom(
      buildSystemSkill('company-1', DEFINITION, PLACEMENT),
      { status: 'archived', name: 'Old name' },
    );
    const revived = {
      ...archived,
      status: 'active',
      name: DEFINITION.name,
      revision: 2,
    };
    let updatedId: string | undefined;
    const result = await provisionSystemSkill(
      {
        skill: {
          findFirst: async () => null,
          findUnique: async ({ where }: { where: { id: string } }) => {
            assert.equal(where.id, archived.id);
            return archived;
          },
          create: async () => {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          },
          update: async ({ where }: { where: { id: string } }) => {
            updatedId = where.id;
            return revived;
          },
        },
        skillVersion: { upsert: async () => ({}) },
        skillRegistryRevision: { upsert: async () => ({}) },
        skillAccessGrant: { upsert: async () => ({}) },
        skillAlias: {
          deleteMany: async () => ({ count: 0 }),
          createMany: async () => ({ count: 1 }),
        },
      } as never,
      'company-1',
      DEFINITION,
      PLACEMENT,
    );

    assert.equal(updatedId, archived.id);
    assert.deepEqual(result, { id: archived.id, outcome: 'updated' });
  });
});
