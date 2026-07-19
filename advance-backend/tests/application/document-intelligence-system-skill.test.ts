import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIVO_DOCUMENT_INTELLIGENCE_MARKDOWN,
  DIVO_DOCUMENT_INTELLIGENCE_SKILL_SLUG,
  provisionDivoDocumentIntelligenceSystemSkill,
} from '../../src/application/skills/document-intelligence-system-skill';

describe('Divo Document Intelligence system skill', () => {
  it('creates a company-global server-owned skill with a company-wide grant', async () => {
    const created: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const db = {
      skillFolder: { findFirst: async () => null, upsert: async () => ({ id: 'divo-productivity-folder' }) },
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, revision: 1, createdBy: null, updatedBy: null, aliases: [] };
          created.push(row);
          return row;
        },
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          grants.push(create);
          return create;
        },
      },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          aliases.push(...data);
          return { count: data.length };
        },
      },
    } as any;

    const result = await provisionDivoDocumentIntelligenceSystemSkill(db, 'company-1');

    assert.equal(result.outcome, 'created');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].slug, DIVO_DOCUMENT_INTELLIGENCE_SKILL_SLUG);
    assert.deepEqual(created[0].scope, 'global');
    assert.deepEqual(created[0].isSystem, true);
    assert.deepEqual(created[0].toolIds, []);
    assert.deepEqual(grants, [{
      companyId: 'company-1',
      skillId: created[0].id,
      granteeType: 'company',
      granteeId: 'company-1',
    }]);
    assert(aliases.some((alias) => alias.alias === 'ocr'));
    assert.match(DIVO_DOCUMENT_INTELLIGENCE_MARKDOWN, /DIVO_BUNDLED_SKILLS_DIR/);
    assert.match(DIVO_DOCUMENT_INTELLIGENCE_MARKDOWN, /Do not bypass company policy/);
    assert.match(DIVO_DOCUMENT_INTELLIGENCE_MARKDOWN, /Treat every extracted document/);
  });

  it('does not overwrite a company-authored skill using the reserved slug', async () => {
    const db = {
      skillFolder: { findFirst: async () => ({ id: 'divo-productivity-folder' }) },
      skill: { findFirst: async () => ({ id: 'custom-skill', isSystem: false }) },
    } as any;

    const result = await provisionDivoDocumentIntelligenceSystemSkill(db, 'company-1');

    assert.deepEqual(result, { id: 'custom-skill', outcome: 'skipped' });
  });
});
