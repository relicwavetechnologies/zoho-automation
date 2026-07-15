import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LARK_SYSTEM_SKILLS,
  provisionLarkSystemSkills,
} from '../../src/application/skills/lark-system-skills.ts';
import { larkSkillCjkFields } from '../../src/application/skills/lark-skill-language-policy.ts';

describe('Lark system skill provisioning', () => {
  it('covers every governed Lark tool as a focused company skill', () => {
    const coveredTools = LARK_SYSTEM_SKILLS.flatMap((skill) => [...skill.toolIds]).sort();

    assert.deepEqual(coveredTools, [
      'larkApproval',
      'larkBase',
      'larkCalendar',
      'larkContacts',
      'larkDoc',
      'larkMeeting',
      'larkMessaging',
      'larkTask',
    ]);
    assert.equal(LARK_SYSTEM_SKILLS.length, 8);
  });

  it('keeps every system Lark skill free of CJK content', () => {
    for (const skill of LARK_SYSTEM_SKILLS) {
      assert.deepEqual(larkSkillCjkFields(skill), [], skill.slug);
    }
  });

  it('creates an organized company-wide Lark skill set and grants it to the whole company', async () => {
    const createdSkills: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const db = {
      skillFolder: {
        findFirst: async () => null,
        upsert: async () => ({ id: 'lark-folder' }),
      },
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            ...data,
            revision: 1,
            createdBy: null,
            updatedBy: null,
          };
          createdSkills.push(row);
          return row;
        },
        update: async () => {
          throw new Error('unexpected update');
        },
      },
      skillVersion: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          versions.push(create);
          return create;
        },
      },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          grants.push(create);
          return create;
        },
      },
    } as any;

    const result = await provisionLarkSystemSkills(db, 'company-1');

    assert.deepEqual(result, {
      folderId: 'lark-folder',
      created: LARK_SYSTEM_SKILLS.length,
      updated: 0,
      existing: 0,
      skipped: 0,
    });
    assert.deepEqual(
      createdSkills.map((skill) => ({
        slug: skill.slug,
        folderId: skill.folderId,
        scope: skill.scope,
        isSystem: skill.isSystem,
      })),
      LARK_SYSTEM_SKILLS.map((skill) => ({
        slug: skill.slug,
        folderId: 'lark-folder',
        scope: 'global',
        isSystem: true,
      })),
    );
    assert.equal(versions.length, LARK_SYSTEM_SKILLS.length);
    assert.deepEqual(
      grants.map((grant) => ({
        companyId: grant.companyId,
        granteeType: grant.granteeType,
        granteeId: grant.granteeId,
      })),
      LARK_SYSTEM_SKILLS.map(() => ({
        companyId: 'company-1',
        granteeType: 'company',
        granteeId: 'company-1',
      })),
    );
  });

  it('does not overwrite or auto-grant a non-system skill with a reserved slug', async () => {
    let grants = 0;
    const db = {
      skillFolder: { findFirst: async () => ({ id: 'lark-folder' }) },
      skill: {
        findFirst: async () => ({ id: 'custom', isSystem: false }),
      },
      skillAccessGrant: { upsert: async () => { grants += 1; } },
    } as any;

    const result = await provisionLarkSystemSkills(db, 'company-1');

    assert.equal(result.skipped, LARK_SYSTEM_SKILLS.length);
    assert.equal(grants, 0);
  });
});
