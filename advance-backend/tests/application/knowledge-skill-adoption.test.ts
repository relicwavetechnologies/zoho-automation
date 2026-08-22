import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adoptLegacySkillsIntoKnowledge } from '../../src/application/knowledge/knowledge-skill-adoption';

const baseSkill = {
  id: 'skill-1',
  companyId: 'company-1',
  departmentId: 'department-1',
  knowledgeResourceId: null as string | null,
  scope: 'department',
  name: 'Cursor HTML design',
  slug: 'cursor-design-html',
  summary: 'Build Cursor-style HTML interfaces.',
  markdown: '# Cursor HTML design\n\nFollow the checklist.',
  toolIds: [],
  tags: ['design'],
  status: 'active',
  isSystem: false,
  revision: 3,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  accessGrants: [{ granteeType: 'department', granteeId: 'department-1' }],
};

describe('legacy skill knowledge adoption', () => {
  it('links the existing skill to an exact canonical starting version', async () => {
    const skill = structuredClone(baseSkill);
    let resource: Record<string, any> | null = null;
    let version: Record<string, any> | null = null;
    const tx = {
      skill: {
        findUnique: async () => skill,
        updateMany: async ({ data }: any) => {
          if (skill.knowledgeResourceId) return { count: 0 };
          skill.knowledgeResourceId = data.knowledgeResourceId;
          return { count: 1 };
        },
      },
      user: { findMany: async () => [{ id: 'user-1' }] },
      knowledgeResource: {
        findUnique: async () => resource,
        create: async ({ data }: any) => {
          resource = { id: 'resource-1', ...data, projectedSkill: null };
          return resource;
        },
      },
      knowledgeVersion: {
        findUnique: async () => version,
        create: async ({ data }: any) => {
          version = { id: 'version-1', ...data };
          return version;
        },
      },
    };
    const db = {
      skill: { findMany: async () => [structuredClone(baseSkill)] },
      $transaction: async (work: (store: typeof tx) => Promise<unknown>) => work(tx),
    };

    const result = await adoptLegacySkillsIntoKnowledge(db as never);

    assert.deepEqual(result, { candidates: 1, adopted: 1, existing: 0, skipped: [] });
    assert.equal(skill.knowledgeResourceId, 'resource-1');
    assert.equal(resource?.scope, 'department');
    assert.equal(resource?.targetKey, 'department:department-1');
    assert.equal(resource?.currentVersion, 3);
    assert.equal(version?.version, 3);
    assert.equal(version?.contentJson.slug, 'cursor-design-html');
    assert.equal(version?.sourceType, 'migration');
  });

  it('does not adopt a skill whose custom access would change after projection', async () => {
    let transactionCalls = 0;
    const customAccess = {
      ...structuredClone(baseSkill),
      accessGrants: [{ granteeType: 'user', granteeId: 'user-2' }],
    };
    const db = {
      skill: { findMany: async () => [customAccess] },
      $transaction: async () => { transactionCalls += 1; },
    };

    const result = await adoptLegacySkillsIntoKnowledge(db as never);

    assert.equal(transactionCalls, 0);
    assert.deepEqual(result.skipped, [{
      skillId: 'skill-1',
      slug: 'cursor-design-html',
      reason: 'access_not_scope_derived',
    }]);
  });
});
