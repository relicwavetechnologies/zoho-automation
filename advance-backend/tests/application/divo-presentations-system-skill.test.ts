import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIVO_PRESENTATIONS_MARKDOWN,
  DIVO_PRESENTATIONS_SKILL_SLUG,
  provisionDivoPresentationsSystemSkill,
} from '../../src/application/skills/divo-presentations-system-skill';

describe('Divo Presentations system skill', () => {
  it('creates a company-wide router without making local work depend on Google Slides permission', async () => {
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

    const result = await provisionDivoPresentationsSystemSkill(db, 'company-1');

    assert.equal(result.outcome, 'created');
    assert.equal(created.length, 1);
    assert.equal(created[0].slug, DIVO_PRESENTATIONS_SKILL_SLUG);
    assert.equal(created[0].scope, 'company');
    assert.equal(created[0].isSystem, true);
    assert.deepEqual(created[0].toolIds, []);
    assert.deepEqual(grants, [{
      companyId: 'company-1',
      skillId: created[0].id,
      granteeType: 'company',
      granteeId: 'company-1',
    }]);
    assert(aliases.some((alias) => alias.alias === 'create powerpoint'));
    assert.match(DIVO_PRESENTATIONS_MARKDOWN, /existing \*\*Google Slides\*\* Divo skill/);
    assert.match(DIVO_PRESENTATIONS_MARKDOWN, /not yet a Divo-owned local capability/);
    assert.doesNotMatch(DIVO_PRESENTATIONS_MARKDOWN, /pptxgenjs|LibreOffice/i);
  });

  it('does not overwrite a company-authored presentation skill using the reserved slug', async () => {
    const db = {
      skillFolder: { findFirst: async () => ({ id: 'divo-productivity-folder' }) },
      skill: { findFirst: async () => ({ id: 'custom-skill', isSystem: false }) },
    } as any;

    assert.deepEqual(
      await provisionDivoPresentationsSystemSkill(db, 'company-1'),
      { id: 'custom-skill', outcome: 'skipped' },
    );
  });
});
