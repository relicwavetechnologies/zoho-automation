import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_PUBLISHING_REGISTERED_TOOL,
  provisionShareMemoryForExistingCompanies,
} from '../../src/application/skills/share-memory-provisioning.ts';

describe('Share Memory provisioning', () => {
  it('creates the registered capability and missing system skill without modifying existing rows', async () => {
    const createdTools: unknown[] = [];
    const createdSkills: unknown[] = [];
    const db = {
      registeredTool: {
        findUnique: async () => null,
        create: async ({ data }: { data: unknown }) => {
          createdTools.push(data);
          return { id: 'memory-publishing' };
        },
      },
      company: { findMany: async () => [{ id: 'company-1' }, { id: 'company-2' }] },
      skill: {
        findFirst: async ({ where }: { where: { companyId: string } }) =>
          where.companyId === 'company-2' ? { id: 'existing-skill', isSystem: false } : null,
        upsert: async ({ create }: { create: unknown }) => {
          createdSkills.push(create);
          return { id: 'new-skill' };
        },
      },
    } as any;

    const result = await provisionShareMemoryForExistingCompanies(db);

    assert.deepEqual(result, {
      registeredToolCreated: true,
      skillsCreated: 1,
      skillsUpdated: 0,
      skillsExisting: 1,
    });
    assert.deepEqual(createdTools, [{
      ...MEMORY_PUBLISHING_REGISTERED_TOOL,
      guardrails: [...MEMORY_PUBLISHING_REGISTERED_TOOL.guardrails],
      engines: [],
      deprecated: false,
    }]);
    assert.equal((createdSkills[0] as { companyId: string }).companyId, 'company-1');
  });
});
