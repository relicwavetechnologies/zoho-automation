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

  it('defines durable company-person aliases for Lark Contacts', () => {
    const contacts = LARK_SYSTEM_SKILLS.find((skill) => skill.slug === 'lark-contacts');
    assert(contacts);
    assert.deepEqual(contacts.aliases, [
      'employee lookup',
      'company directory',
      'colleague search',
      'staff contact',
      'resolve person',
    ]);
    assert.match(contacts.markdown, /job title, department names, and organization when available/);
    assert.match(contacts.markdown, /Never include that block or any Lark ID in user-facing output/);
    assert.match(contacts.markdown, /Omit fields the governed directory did not return/);
  });

  it('creates an organized company-wide Lark skill set and grants it to the whole company', async () => {
    const createdSkills: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
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
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          aliases.push(...data);
          return { count: data.length };
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
    const contacts = createdSkills.find((skill) => skill.slug === 'lark-contacts');
    assert(aliases.some((alias) => alias.skillId === contacts?.id && alias.alias === 'company directory'));
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
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
      },
      skillAccessGrant: { upsert: async () => { grants += 1; } },
    } as any;

    const result = await provisionLarkSystemSkills(db, 'company-1');

    assert.equal(result.skipped, LARK_SYSTEM_SKILLS.length);
    assert.equal(grants, 0);
  });
});
