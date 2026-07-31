/**
 * Unit tests for the Skill Registry admin service.
 *
 * Covers the algorithmically load-bearing pieces directly (cycle detection,
 * subtree collection, tree assembly) plus the service's scope-validation
 * branches via targeted prisma stubs — no real database.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SkillRegistryAdminService,
  isDescendant,
  collectSubtree,
  buildTree,
  buildFolderPath,
  auditRefsSkill,
} from '../../src/application/skills/skill-registry-admin.service.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this as typeof noopLogger; },
} as any;

// A tiny prisma stub: each test wires only the methods its path touches.
function stubService(overrides: Record<string, unknown>): SkillRegistryAdminService {
  return new SkillRegistryAdminService({ prisma: overrides as any, logger: noopLogger });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('isDescendant', () => {
  const folders = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'd', parentId: null },
  ];

  it('detects a node inside the ancestor subtree', () => {
    assert.equal(isDescendant(folders, 'a', 'c'), true);
    assert.equal(isDescendant(folders, 'a', 'b'), true);
  });

  it('rejects unrelated / sibling nodes', () => {
    assert.equal(isDescendant(folders, 'b', 'd'), false);
    assert.equal(isDescendant(folders, 'c', 'a'), false);
  });

  it('does not loop forever on cyclic data', () => {
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    assert.equal(isDescendant(cyclic, 'z', 'x'), false);
  });
});

describe('collectSubtree', () => {
  it('returns the folder plus all descendants', () => {
    const folders = [
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
      { id: 'sib', parentId: null },
    ];
    const sub = collectSubtree(folders, 'a').sort();
    assert.deepEqual(sub, ['a', 'b', 'c']);
    assert.deepEqual(collectSubtree(folders, 'c'), ['c']);
  });
});

describe('buildTree', () => {
  const departments = [{ id: 'dep-fin', name: 'Finance' }];

  const folders = [
    { id: 'shared', name: 'Shared', slug: 'shared', departmentId: null, parentId: null, status: 'active' },
    { id: 'fin-root', name: 'General', slug: 'general', departmentId: 'dep-fin', parentId: null, status: 'active' },
    { id: 'fin-child', name: 'Ops', slug: 'ops', departmentId: 'dep-fin', parentId: 'fin-root', status: 'active' },
  ];

  const skill = (over: Record<string, unknown>) => ({
    id: 'sk', name: 'S', slug: 's', summary: '', toolIds: [], tags: [],
    status: 'active', scope: 'department', departmentId: 'dep-fin', folderId: null,
    isSystem: false, revision: 1, updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  });

  it('nests folders and attaches skills to their folder', () => {
    const skills = [skill({ id: 'in-child', folderId: 'fin-child' })];
    const tree = buildTree(folders, skills as any, departments, 7);

    assert.equal(tree.registryRevision, 7);
    const fin = tree.departments[0]!;
    assert.equal(fin.folders[0]!.id, 'fin-root');
    assert.equal(fin.folders[0]!.children[0]!.id, 'fin-child');
    assert.equal(fin.folders[0]!.children[0]!.skills[0]!.id, 'in-child');
  });

  it('routes company-wide skills to the companyWide root', () => {
    const skills = [skill({ id: 'cw', scope: 'global', departmentId: null, folderId: null })];
    const tree = buildTree(folders, skills as any, departments, 1);
    assert.equal(tree.companyWide.skills[0]!.id, 'cw');
  });

  it('parks skills whose folder is missing (archived) at the scope root', () => {
    // folderId points at a folder not in the active set → falls back to root.
    const skills = [skill({ id: 'orphan', folderId: 'archived-folder' })];
    const tree = buildTree(folders, skills as any, departments, 1);
    assert.equal(tree.departments[0]!.skills[0]!.id, 'orphan');
  });
});

// ── moveSkill scope validation ───────────────────────────────────────────────
describe('SkillRegistryAdminService.moveSkill', () => {
  it('rejects placing a company-wide skill into a department folder', async () => {
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'global', departmentId: null }) },
      skillFolder: { findFirst: async () => ({ id: 'f', departmentId: 'dep-fin' }) },
    });
    const r = await svc.moveSkill('co', 'sk', 'u', { folderId: 'f' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it("rejects placing a department skill into another department's folder", async () => {
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'department', departmentId: 'dep-fin' }) },
      skillFolder: { findFirst: async () => ({ id: 'f', departmentId: 'dep-sales' }) },
    });
    const r = await svc.moveSkill('co', 'sk', 'u', { folderId: 'f' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it('allows a matching department placement', async () => {
    let updated: unknown = null;
    const svc = stubService({
      skill: {
        findFirst: async () => ({ id: 'sk', scope: 'department', departmentId: 'dep-fin' }),
        update: async (args: unknown) => { updated = args; return {}; },
      },
      skillFolder: { findFirst: async () => ({ id: 'f', departmentId: 'dep-fin' }) },
    });
    const r = await svc.moveSkill('co', 'sk', 'u', { folderId: 'f' });
    assert.equal(r.ok, true);
    assert.ok(updated);
  });

  it('allows detaching to root (folderId null) without a folder lookup', async () => {
    const svc = stubService({
      skill: {
        findFirst: async () => ({ id: 'sk', scope: 'department', departmentId: 'dep-fin' }),
        update: async () => ({}),
      },
    });
    const r = await svc.moveSkill('co', 'sk', 'u', { folderId: null });
    assert.equal(r.ok, true);
  });

  it('404s an unknown skill', async () => {
    const svc = stubService({ skill: { findFirst: async () => null } });
    const r = await svc.moveSkill('co', 'nope', 'u', { folderId: null });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });
});

// ── Pure helpers: folder path + audit matching ───────────────────────────────
describe('buildFolderPath', () => {
  const folders = [
    { id: 'root', name: 'General', parentId: null },
    { id: 'mid', name: 'Ops', parentId: 'root' },
    { id: 'leaf', name: 'Bills', parentId: 'mid' },
  ];

  it('returns root → leaf names', () => {
    assert.deepEqual(buildFolderPath(folders, 'leaf'), ['General', 'Ops', 'Bills']);
    assert.deepEqual(buildFolderPath(folders, 'root'), ['General']);
  });

  it('stops safely on missing or cyclic parents', () => {
    assert.deepEqual(buildFolderPath(folders, 'ghost'), []);
    const cyclic = [
      { id: 'x', name: 'X', parentId: 'y' },
      { id: 'y', name: 'Y', parentId: 'x' },
    ];
    // Must terminate; order is leaf → up then reversed.
    assert.deepEqual(buildFolderPath(cyclic, 'x'), ['Y', 'X']);
  });
});

describe('auditRefsSkill', () => {
  it('matches metadata.skillId', () => {
    assert.equal(auditRefsSkill({ skillId: 'sk-1' }, 'sk-1'), true);
    assert.equal(auditRefsSkill({ skillId: 'other' }, 'sk-1'), false);
  });
  it('matches inside metadata.skillIds[]', () => {
    assert.equal(auditRefsSkill({ skillIds: ['a', 'sk-1'] }, 'sk-1'), true);
    assert.equal(auditRefsSkill({ skillIds: ['a', 'b'] }, 'sk-1'), false);
  });
  it('rejects non-object / empty metadata', () => {
    assert.equal(auditRefsSkill(null, 'sk-1'), false);
    assert.equal(auditRefsSkill('sk-1', 'sk-1'), false);
    assert.equal(auditRefsSkill({}, 'sk-1'), false);
  });
});

// ── getSkillAccess (per-skill RBAC grants, deny-by-default) ──────────────────
describe('SkillRegistryAdminService.getSkillAccess', () => {
  // Full stub set for the getSkillAccess fan-out (company/dept/role/user/grants).
  const accessStub = (over: Record<string, unknown> = {}) => stubService({
    skill: { findFirst: async () => ({ id: 'sk', scope: 'department', departmentId: 'dep-fin' }) },
    company: { findUnique: async () => ({ id: 'co', name: 'Acme' }) },
    department: { findMany: async () => [{ id: 'dep-fin', name: 'Finance' }] },
    departmentRole: { findMany: async () => [
      { id: 'r-mgr', name: 'Manager', department: { name: 'Finance' } },
      { id: 'r-mem', name: 'Member', department: { name: 'Finance' } },
    ] },
    adminMembership: { findMany: async () => [{ user: { id: 'u1', name: 'Aarav', email: 'aarav@acme.com' } }] },
    skillAccessGrant: { findMany: async () => [] },
    ...over,
  });

  it('buckets ungranted grantees into users/departments/roles/company', async () => {
    const r = await accessStub().getSkillAccess('co', 'sk');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.candidates.users.map((c) => c.granteeId), ['u1']);
    assert.deepEqual(r.value.candidates.departments.map((c) => c.granteeId), ['dep-fin']);
    assert.deepEqual(r.value.candidates.roles.map((c) => c.granteeId), ['r-mgr', 'r-mem']);
    assert.equal(r.value.candidates.company?.granteeId, 'co');
    assert.equal(r.value.grants.length, 0);
  });

  it('resolves grant labels and drops granted grantees from candidates', async () => {
    const r = await accessStub({
      skillAccessGrant: { findMany: async () => [
        { granteeType: 'department', granteeId: 'dep-fin', grantedBy: 'admin', createdAt: new Date('2026-07-14T00:00:00Z') },
        { granteeType: 'company', granteeId: 'co', grantedBy: 'admin', createdAt: new Date('2026-07-14T00:00:00Z') },
      ] },
    }).getSkillAccess('co', 'sk');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const dept = r.value.grants.find((g) => g.granteeType === 'department')!;
    assert.equal(dept.label, 'Finance');
    assert.equal(r.value.candidates.departments.length, 0); // now granted → not a candidate
    assert.equal(r.value.candidates.company, null);         // company granted → not a candidate
  });

  it('404s an unknown skill', async () => {
    const svc = stubService({ skill: { findFirst: async () => null } });
    const r = await svc.getSkillAccess('co', 'nope');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });
});

// ── grantSkillAccess / revokeSkillAccess ─────────────────────────────────────
describe('SkillRegistryAdminService.grantSkillAccess', () => {
  it("rejects granting a department skill to another department (validation)", async () => {
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'department', departmentId: 'dep-fin' }) },
      department: { findFirst: async () => ({ id: 'dep-sales', name: 'Sales' }) },
    });
    const r = await svc.grantSkillAccess('co', 'sk', 'department', 'dep-sales', 'admin');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it('grants a company-wide skill to a whole department', async () => {
    let created: any = null;
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'global', departmentId: null }) },
      department: { findFirst: async () => ({ id: 'dep-sales', name: 'Sales' }) },
      skillAccessGrant: { upsert: async (args: any) => { created = args.create; return { grantedBy: 'admin', createdAt: new Date('2026-07-14T00:00:00Z') }; } },
    });
    const r = await svc.grantSkillAccess('co', 'sk', 'department', 'dep-sales', 'admin');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(created.granteeType, 'department');
    assert.equal(created.granteeId, 'dep-sales');
    assert.equal(r.value.label, 'Sales');
  });

  it('grants a skill to the whole company', async () => {
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'global', departmentId: null }) },
      company: { findUnique: async () => ({ name: 'Acme' }) },
      skillAccessGrant: { upsert: async () => ({ grantedBy: 'admin', createdAt: new Date('2026-07-14T00:00:00Z') }) },
    });
    const r = await svc.grantSkillAccess('co', 'sk', 'company', 'co', 'admin');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.detail, 'Whole company');
  });

  it('404s an unknown user grantee', async () => {
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk', scope: 'global', departmentId: null }) },
      adminMembership: { findFirst: async () => null },
    });
    const r = await svc.grantSkillAccess('co', 'sk', 'user', 'ghost', 'admin');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });
});

describe('SkillRegistryAdminService.revokeSkillAccess', () => {
  it('deletes the grant for the skill + grantee', async () => {
    let deletedWhere: any = null;
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk' }) },
      skillAccessGrant: { deleteMany: async (args: any) => { deletedWhere = args.where; return { count: 1 }; } },
    });
    const r = await svc.revokeSkillAccess('co', 'sk', 'role', 'r');
    assert.equal(r.ok, true);
    assert.equal(deletedWhere.skillId, 'sk');
    assert.equal(deletedWhere.granteeType, 'role');
    assert.equal(deletedWhere.granteeId, 'r');
    assert.equal(deletedWhere.companyId, 'co');
  });

  it('404s an unknown skill', async () => {
    const svc = stubService({ skill: { findFirst: async () => null } });
    const r = await svc.revokeSkillAccess('co', 'nope', 'role', 'r');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });
});

// ── getSkillAudit (skill-scoped audit trail) ─────────────────────────────────
describe('SkillRegistryAdminService.getSkillAudit', () => {
  it('keeps only rows that reference the skill, newest first, capped by limit', async () => {
    const rows = [
      { id: 'a1', action: 'gateway.skill.get', actorId: 'u1', outcome: 'success', metadata: { skillId: 'sk' }, createdAt: new Date('2026-07-14T10:00:00Z') },
      { id: 'a2', action: 'gateway.skill.search', actorId: 'u2', outcome: 'success', metadata: { skillIds: ['other', 'sk'] }, createdAt: new Date('2026-07-14T09:00:00Z') },
      { id: 'a3', action: 'gateway.skill.get', actorId: 'u3', outcome: 'success', metadata: { skillId: 'other' }, createdAt: new Date('2026-07-14T08:00:00Z') },
    ];
    const svc = stubService({
      skill: { findFirst: async () => ({ id: 'sk' }) },
      auditLog: { findMany: async () => rows },
    });
    const r = await svc.getSkillAudit('co', 'sk', { limit: 10 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.map((e) => e.id), ['a1', 'a2']); // a3 filtered out
    assert.equal(typeof r.value[0]!.createdAt, 'string');
  });

  it('404s an unknown skill', async () => {
    const svc = stubService({ skill: { findFirst: async () => null } });
    const r = await svc.getSkillAudit('co', 'nope');
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });
});

// ── moveFolder guards ────────────────────────────────────────────────────────
describe('SkillRegistryAdminService.moveFolder', () => {
  it('rejects moving a folder into itself', async () => {
    const svc = stubService({
      skillFolder: { findFirst: async () => ({ id: 'f', slug: 'f', departmentId: null, parentId: null }) },
    });
    const r = await svc.moveFolder('co', 'f', 'u', { parentId: 'f' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it('rejects crossing the company-wide / department boundary', async () => {
    const svc = stubService({
      skillFolder: {
        findFirst: async (args: any) =>
          args.where.id === 'f'
            ? { id: 'f', slug: 'f', departmentId: null, parentId: null }
            : { id: 'p', departmentId: 'dep-fin' },
      },
    });
    const r = await svc.moveFolder('co', 'f', 'u', { parentId: 'p' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });
});
