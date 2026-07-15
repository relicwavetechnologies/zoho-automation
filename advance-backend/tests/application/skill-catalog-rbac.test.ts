/**
 * Skill-catalog visibility under per-skill RBAC enforcement.
 *
 * The gateway always supplies `grantedSkillIds`, so visibility is deny-by-default
 * and driven purely by explicit grants — independent of the member's tool
 * permissions. The fallback (grantedSkillIds omitted → legacy tool-derived
 * visibility) applies only when no enforcement port is wired.
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
];

function catalog() {
  return new SkillCatalogService({ repo: makeRepo(rows), logger: noopLogger });
}

describe('SkillCatalogService — tool-derived fallback (no grants supplied)', () => {
  it('shows only skills whose every tool the member can use', async () => {
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission });
    assert.deepEqual(visible.map((s) => s.id), ['sk-books']);
  });
});

describe('SkillCatalogService — grant-based visibility (the live model)', () => {
  it('shows only granted skills, ignoring tool permissions', async () => {
    // Grant the CRM skill the member could NOT otherwise see; withhold the
    // books skill the member's tools would otherwise allow.
    const grantedSkillIds = new Set(['sk-crm']);
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds });
    assert.deepEqual(visible.map((s) => s.id), ['sk-crm']);
  });

  it('hides everything when nothing is granted (deny-by-default)', async () => {
    const visible = await catalog().listVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds: new Set() });
    assert.deepEqual(visible, []);
  });

  it('applies the same gate to getVisible', async () => {
    const grantedSkillIds = new Set(['sk-crm']);
    const crm = await catalog().getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: 'sk-crm' });
    const books = await catalog().getVisible({ companyId: 'co', departmentId: 'dep', permission, grantedSkillIds, skillId: 'sk-books' });
    assert.equal(crm?.id, 'sk-crm');
    assert.equal(books, null); // tool-usable but not granted → hidden
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
