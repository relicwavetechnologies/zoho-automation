/**
 * Skill-catalog visibility under per-skill RBAC enforcement.
 *
 * The gateway always supplies `grantedSkillIds`, so visibility is deny-by-default
 * and requires both an explicit grant and permission for every declared tool.
 * Instruction-only skills declare no tools and remain safe to load.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillCatalogService } from '../../src/application/skills/skill-catalog.service.ts';
import type { SkillRepoPort, SkillRow } from '../../src/infrastructure/persistence/skill.repository.ts';
import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import { ok } from '../../src/shared/result.ts';
import { asToolId } from '../../src/shared/ids.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this as typeof noopLogger; },
} as any;

function row(id: string, toolIds: string[]): SkillRow {
  return {
    id, slug: id, name: id, summary: '', markdown: '# ' + id,
    toolIds, scope: 'department', status: 'active', tags: [],
    companyId: 'co', departmentId: 'dep', revision: 1,
  };
}

function makeRepo(rows: SkillRow[]): SkillRepoPort {
  return {
    list: async () => ok(rows),
    search: async () => ok(rows),
    findById: async ({ skillId }) => ok(rows.find((r) => r.id === skillId) ?? null),
    registryRevision: async () => ok(1),
  };
}

// A member who can use zohoBooks but not zohoCrm.
const permission = {
  allowedToolIds: new Set([asToolId('zohoBooks')]),
  allowedActionsByTool: new Map(),
  decisions: [],
} as unknown as PermissionResult;

const rows = [
  row('sk-books', ['zohoBooks']),        // tool-usable
  row('sk-crm', ['zohoCrm']),            // NOT tool-usable
  row('sk-instructions', []),             // instruction-only
];

function catalog() {
  return new SkillCatalogService({ repo: makeRepo(rows), logger: noopLogger });
}

describe('SkillCatalogService — tool-derived fallback (no grants supplied)', () => {
  it('shows only skills whose every tool the member can use', async () => {
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission });
    assert.deepEqual(visible.map((s) => s.id), ['sk-books', 'sk-instructions']);
  });
});

describe('SkillCatalogService — grant-based visibility (the live model)', () => {
  it('requires both a grant and permission for every required tool', async () => {
    const grantedSkillIds = new Set(['sk-books', 'sk-crm', 'sk-instructions']);
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds });
    assert.deepEqual(visible.map((s) => s.id), ['sk-books', 'sk-instructions']);
  });

  it('hides everything when nothing is granted (deny-by-default)', async () => {
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds: new Set() });
    assert.deepEqual(visible, []);
  });

  it('applies the same gate to getVisible', async () => {
    const grantedSkillIds = new Set(['sk-books', 'sk-crm', 'sk-instructions']);
    const crm = await catalog().getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: 'sk-crm' });
    const books = await catalog().getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: 'sk-books' });
    const instructions = await catalog().getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: 'sk-instructions' });
    assert.equal(crm, null);
    assert.equal(books?.id, 'sk-books');
    assert.equal(instructions?.id, 'sk-instructions');
  });
});

describe('SkillCatalogService — Lark language safety', () => {
  const unsafeLark = {
    ...row('sk-lark-chinese', ['larkDoc']),
    name: 'Lark 文档',
    summary: '创建文档',
    markdown: '# Lark 文档\n\n创建一份文档。',
    tags: ['lark', '文档'],
  };

  it('fails closed when a Chinese Lark skill bypasses application write validation', async () => {
    const service = new SkillCatalogService({ repo: makeRepo([unsafeLark]), logger: noopLogger });
    const grantedSkillIds = new Set([unsafeLark.id]);

    const listed = await service.listVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds });
    const fetched = await service.getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: unsafeLark.id });
    const inScope = await service.getInScope({ companyId: 'co', departmentId: 'dep', skillId: unsafeLark.id });

    assert.deepEqual(listed, []);
    assert.equal(fetched, null);
    assert.equal(inScope, null);
  });
});

describe('SkillCatalogService — alias ranking', () => {
  it('keeps an alias-only match instead of discarding the repository candidate', async () => {
    const sheets = {
      ...row('sk-sheets', ['zohoBooks']),
      name: 'Tabular workspace',
      aliases: ['spreadsheet', 'dropdown'],
    };
    const service = new SkillCatalogService({ repo: makeRepo([sheets]), logger: noopLogger });
    const matches = await service.searchVisible({
      companyId: 'co', departmentId: 'dep', permission,
      grantedSkillIds: new Set([sheets.id]), query: 'spreadsheet dropdown', limit: 3,
    });
    assert.equal(matches[0]?.skill.id, sheets.id);
    assert(matches[0]!.score > 0);
  });

  it('uses exact tokens instead of matching short query text inside unrelated words', async () => {
    const exact = {
      ...row('sk-mail', ['zohoBooks']),
      name: 'Mail helper',
      tags: ['mail'],
    };
    const substringOnly = {
      ...row('sk-email', ['zohoBooks']),
      name: 'Email helper',
      tags: ['email'],
    };
    const service = new SkillCatalogService({ repo: makeRepo([substringOnly, exact]), logger: noopLogger });
    const matches = await service.searchVisible({
      companyId: 'co', departmentId: 'dep', permission,
      grantedSkillIds: new Set([exact.id, substringOnly.id]), query: 'mail', limit: 3,
    });
    assert.deepEqual(matches.map((match) => match.skill.id), [exact.id]);
  });
});

describe('SkillCatalogService — governed contact routing', () => {
  const larkContacts = {
    ...row('lark-contacts', ['larkContacts']),
    name: 'Lark Contacts',
    summary: 'Governed company people directory',
    tags: ['lark', 'contacts', 'directory', 'people'],
    aliases: ['employee lookup', 'company directory', 'colleague search', 'staff contact', 'resolve person'],
  };
  const googleContacts = {
    ...row('google-contacts', ['googleContacts']),
    name: 'Google Contacts',
    summary: 'Google personal address book',
    tags: ['google', 'workspace', 'contacts'],
    aliases: ['google people', 'address book'],
  };
  const gmail = {
    ...row('google-gmail', ['googleGmail']),
    name: 'Gmail',
    summary: 'Search email by sender name',
    markdown: 'Search messages and resolve recipient contact names and email addresses.',
    tags: ['google', 'gmail', 'email'],
  };
  const contactPermission = {
    allowedToolIds: new Set([asToolId('larkContacts'), asToolId('googleContacts'), asToolId('googleGmail')]),
    allowedActionsByTool: new Map(),
    decisions: [],
  } as unknown as PermissionResult;
  const contactRows = [gmail, googleContacts, larkContacts];

  async function search(query: string) {
    const service = new SkillCatalogService({ repo: makeRepo(contactRows), logger: noopLogger });
    return service.searchVisible({
      companyId: 'co', departmentId: 'dep', permission: contactPermission,
      grantedSkillIds: new Set(contactRows.map((candidate) => candidate.id)), query, limit: 3,
    });
  }

  it('prefers Lark Contacts for generic and company-directory people lookup', async () => {
    for (const query of [
      'Search Contacts for Anish, Shivam, Vijay, Dushayant, Divya and Vibhore',
      'find an employee in the company directory',
      'look up my colleague email',
    ]) {
      assert.equal((await search(query))[0]?.skill.id, 'lark-contacts', query);
    }
  });

  it('honors explicit provider and personal/external address-book intent', async () => {
    for (const query of [
      'search Google Contacts for Anish',
      'look up a personal contact in my address book',
      'find an external contact',
    ]) {
      assert.equal((await search(query))[0]?.skill.id, 'google-contacts', query);
    }
    assert.equal((await search('search Lark Contacts for Anish'))[0]?.skill.id, 'lark-contacts');
  });
});

describe('SkillCatalogService — scheduling intent routing', () => {
  const scheduledWork = {
    ...row('schedule-divo-work', ['scheduledWorkflows']),
    name: 'Schedule Divo Work',
    summary: 'Create recurring Divo work, reminders, reports, and monitoring.',
    markdown: 'Use for agent work that runs later. Ask whether vague scheduling means a calendar event or Divo work.',
    tags: ['scheduling', 'automation', 'recurring', 'monitoring', 'reminder'],
    aliases: ['schedule something', 'schedule work', 'scheduled work', 'recurring task', 'run later'],
  };
  const googleCalendar = {
    ...row('google-calendar', ['googleCalendar']),
    name: 'Google Calendar',
    summary: 'Create calendar events, invite attendees, and check free/busy.',
    markdown: 'Use for meetings and reserving time on a calendar.',
    tags: ['google', 'calendar', 'events'],
    aliases: ['google events', 'schedule', 'availability'],
  };
  const schedulePermission = {
    allowedToolIds: new Set([asToolId('scheduledWorkflows'), asToolId('googleCalendar')]),
    allowedActionsByTool: new Map(),
    decisions: [],
  } as unknown as PermissionResult;

  async function search(query: string) {
    const candidates = [googleCalendar, scheduledWork];
    const service = new SkillCatalogService({ repo: makeRepo(candidates), logger: noopLogger });
    return service.searchVisible({
      companyId: 'co', departmentId: 'dep', permission: schedulePermission,
      grantedSkillIds: new Set(candidates.map((candidate) => candidate.id)), query, limit: 3,
    });
  }

  it('routes a vague scheduling capability question to the Divo scheduling skill', async () => {
    const results = await search('can you schedule something?');
    assert.equal(results[0]?.skill.id, 'schedule-divo-work');
    assert(results[0]!.score >= 8);
  });

  it('keeps meetings and attendee scheduling on the calendar skill', async () => {
    assert.equal(
      (await search('schedule a calendar meeting with attendees'))[0]?.skill.id,
      'google-calendar',
    );
  });
});
