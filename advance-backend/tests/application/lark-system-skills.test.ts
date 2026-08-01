import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LARK_SYSTEM_SKILLS,
  provisionLarkSystemSkills,
} from '../../src/application/skills/lark-system-skills.ts';
import { larkSkillCjkFields } from '../../src/application/skills/lark-skill-language-policy.ts';
import { createLarkApprovalTool } from '../../src/application/tools/families/lark-approval.tool.ts';
import { createLarkBaseTool } from '../../src/application/tools/families/lark-base.tool.ts';
import { createLarkCalendarTool } from '../../src/application/tools/families/lark-calendar.tool.ts';
import { createLarkContactsTool } from '../../src/application/tools/families/lark-contacts.tool.ts';
import { createLarkDocTool } from '../../src/application/tools/families/lark-doc.tool.ts';
import { createLarkMeetingTool } from '../../src/application/tools/families/lark-meeting.tool.ts';
import { createLarkMessagingTool } from '../../src/application/tools/families/lark-messaging.tool.ts';
import { createLarkTaskTool } from '../../src/application/tools/families/lark-task.tool.ts';

function operationOptions(schema: unknown): readonly string[] {
  type SchemaNode = {
    _def?: {
      schema?: SchemaNode;
      shape?: (() => { op?: { options?: readonly string[] } }) | { op?: { options?: readonly string[] } };
    };
  };
  let node = schema as SchemaNode;
  while (node._def?.schema) node = node._def.schema;
  const rawShape = node._def?.shape;
  const shape = typeof rawShape === 'function' ? rawShape() : rawShape;
  assert(shape?.op?.options, 'tool schema must expose an op enum');
  return shape.op.options;
}

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
    assert.equal(LARK_SYSTEM_SKILLS.length, 9);
  });

  it('routes through a tool-free top-level skill before the exact family recipe', () => {
    const router = LARK_SYSTEM_SKILLS.find((skill) => skill.slug === 'lark-router');
    assert(router);
    assert.deepEqual(router.toolIds, []);
    for (const slug of [
      'lark-documents', 'lark-tasks', 'lark-calendar', 'lark-meetings',
      'lark-messaging', 'lark-contacts', 'lark-base', 'lark-approvals',
    ]) {
      assert.match(router.markdown, new RegExp(`\\\`${slug}\\\``));
    }
  });

  it('keeps every family skill operation list identical to its tool schema', () => {
    const tools = [
      createLarkTaskTool({} as never),
      createLarkMessagingTool({} as never),
      createLarkCalendarTool({} as never),
      createLarkMeetingTool({} as never),
      createLarkDocTool({} as never),
      createLarkContactsTool({} as never),
      createLarkBaseTool({} as never),
      createLarkApprovalTool({} as never),
    ];

    for (const tool of tools) {
      const skill = LARK_SYSTEM_SKILLS.find((candidate) => candidate.toolIds.includes(String(tool.id)));
      assert(skill, `missing skill for ${tool.id}`);
      const section = skill.markdown.match(/## Implemented operations\s+([^\n]+)/);
      assert(section, `${skill.slug} must declare implemented operations`);
      const declared = [...section[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      assert.deepEqual(declared, [...operationOptions(tool.argsSchema)], `${skill.slug} operation drift`);
    }
  });

  it('keeps every system Lark skill free of CJK content', () => {
    for (const skill of LARK_SYSTEM_SKILLS) {
      assert.deepEqual(larkSkillCjkFields(skill), [], skill.slug);
      assert.match(skill.markdown, /one persistent Python file only when the work has pagination, a record set plus parsing\/transformation\/grouping\/deduplication\/joining, related writes, or more than one connected product/);
      assert.match(skill.markdown, /Never call Lark directly from Bash/);
    }
  });

  it('keeps user-scoped Lark skills on backend-owned connection selection', () => {
    const userScopedTools = new Set([
      'larkBase',
      'larkCalendar',
      'larkDoc',
      'larkMeeting',
      'larkMessaging',
      'larkTask',
    ]);
    const userScopedSkills = LARK_SYSTEM_SKILLS.filter((skill) =>
      skill.toolIds.some((toolId) => userScopedTools.has(toolId)));

    for (const skill of userScopedSkills) {
      assert.match(skill.markdown, /Otherwise omit `connectionId`/);
      assert.match(skill.markdown, /backend selects an account only when exactly one accessible account qualifies/);
      assert.doesNotMatch(skill.markdown, /List accessible connections|pass its `connectionId`|include its `connectionId` on every action/);
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
    const createdFolders: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const aliases: Record<string, unknown>[] = [];
    const db = {
      skillFolder: {
        findFirst: async () => null,
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          createdFolders.push(create);
          return { id: create.slug === 'lark' ? 'lark-folder' : `${String(create.slug)}-folder` };
        },
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
    const expectedFolders = new Map([
      ['lark-router', 'lark-folder'],
      ['lark-documents', 'documents-drive-folder'],
      ['lark-tasks', 'tasks-folder'],
      ['lark-calendar', 'calendar-folder'],
      ['lark-meetings', 'meetings-folder'],
      ['lark-messaging', 'messaging-folder'],
      ['lark-contacts', 'contacts-folder'],
      ['lark-base', 'base-folder'],
      ['lark-approvals', 'approvals-folder'],
    ]);
    assert.deepEqual(
      createdSkills.map((skill) => ({
        slug: skill.slug,
        folderId: skill.folderId,
        scope: skill.scope,
        isSystem: skill.isSystem,
      })),
      LARK_SYSTEM_SKILLS.map((skill) => ({
        slug: skill.slug,
        folderId: expectedFolders.get(skill.slug),
        scope: 'company',
        isSystem: true,
      })),
    );
    assert.equal(createdFolders.length, 9);
    assert.equal(createdFolders.filter((folder) => folder.parentId === 'lark-folder').length, 8);
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
