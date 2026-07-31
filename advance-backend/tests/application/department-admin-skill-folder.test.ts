/**
 * Unit tests for skill ↔ folder placement in DepartmentAdminService.
 *
 * Phase 2 of the Skill Registry: createSkill / updateSkill accept an optional
 * folderId. A department-scoped skill may only live in a folder that belongs to
 * the same department (or at the root, folderId = null). These tests exercise
 * that guard directly with a targeted prisma stub — no real database.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepartmentAdminService } from '../../src/application/departments/department-admin.service.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this as typeof noopLogger; },
} as any;

const DEPT = { id: 'dep-fin', companyId: 'co-1', name: 'Finance', slug: 'finance' };

/**
 * Builds a service over a minimal prisma stub. `folder` is what
 * skillFolder.findFirst resolves to (null → not found). `captureData`
 * receives the data passed to skill.create / skill.update so tests can
 * assert the persisted folderId.
 */
function makeService(opts: {
  folder?: { departmentId: string | null; status: string } | null;
  existingSkill?: Record<string, unknown> | null;
  onWrite?: (data: Record<string, unknown>) => void;
}): DepartmentAdminService {
  const writtenRow = (data: Record<string, unknown>) => ({
    id: 'sk-1', name: 'S', slug: 's', summary: '', markdown: '# s',
    toolIds: [], tags: [], status: 'active', scope: 'department',
    departmentId: DEPT.id, revision: 1, companyId: 'co-1',
    createdBy: 'u-1', updatedBy: 'u-1',
    folderId: (data['folderId'] as string | null) ?? null,
  });
  const prisma = {
    department: { findFirst: async () => DEPT },
    skillFolder: { findFirst: async () => (opts.folder === undefined ? null : opts.folder) },
    skill: {
      findFirst: async () => (opts.existingSkill === undefined ? null : opts.existingSkill),
      create: async ({ data }: { data: Record<string, unknown> }) => { opts.onWrite?.(data); return writtenRow(data); },
      update: async ({ data }: { data: Record<string, unknown> }) => { opts.onWrite?.(data); return writtenRow(data); },
    },
    skillVersion: { upsert: async () => ({}) },
    skillRegistryRevision: { upsert: async () => ({}) },
  } as any;
  return new DepartmentAdminService({ prisma, logger: noopLogger } as any);
}

const CREATE_INPUT = { name: 'Reconciliation', markdown: '# Reconciliation' };

describe('DepartmentAdminService.createSkill folder placement', () => {
  it('places a skill at the root when folderId is null', async () => {
    let written: Record<string, unknown> | null = null;
    const svc = makeService({ onWrite: (d) => { written = d; } });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', { ...CREATE_INPUT, folderId: null });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.folderId, null);
    assert.equal(written!['folderId'], null);
  });

  it('persists folderId when the folder is in the same department', async () => {
    let written: Record<string, unknown> | null = null;
    const svc = makeService({
      folder: { departmentId: DEPT.id, status: 'active' },
      onWrite: (d) => { written = d; },
    });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', { ...CREATE_INPUT, folderId: 'f-1' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.folderId, 'f-1');
    assert.equal(written!['folderId'], 'f-1');
  });

  it("rejects a folder that belongs to another department", async () => {
    const svc = makeService({ folder: { departmentId: 'dep-sales', status: 'active' } });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', { ...CREATE_INPUT, folderId: 'f-1' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it('rejects a missing folder', async () => {
    const svc = makeService({ folder: null });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', { ...CREATE_INPUT, folderId: 'gone' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });

  it('rejects an archived folder', async () => {
    const svc = makeService({ folder: { departmentId: DEPT.id, status: 'archived' } });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', { ...CREATE_INPUT, folderId: 'f-1' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'not_found');
  });

  it('rejects Chinese Lark skill content before writing', async () => {
    let wrote = false;
    const svc = makeService({ onWrite: () => { wrote = true; } });
    const r = await svc.createSkill(DEPT.id, 'co-1', 'u-1', {
      name: 'Lark 文档',
      summary: '创建文档',
      markdown: '# Lark 文档',
      toolIds: ['larkDoc'],
      tags: ['lark'],
    });

    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
    assert.match(r.ok ? '' : r.error.message, /must be stored in English/);
    assert.equal(wrote, false);
  });
});

describe('DepartmentAdminService.updateSkill folder placement', () => {
  const existing = {
    id: 'sk-1', departmentId: DEPT.id, revision: 1,
    slug: 'reconciliation', name: 'Reconciliation', summary: '',
    markdown: '# Reconciliation', toolIds: [], tags: [],
  };

  it('leaves folderId untouched when it is omitted (no folder lookup)', async () => {
    let written: Record<string, unknown> | null = null;
    // No folder configured: if the code looked one up it would 404. It must not.
    const svc = makeService({ existingSkill: existing, onWrite: (d) => { written = d; } });
    const r = await svc.updateSkill(DEPT.id, 'co-1', 'sk-1', 'u-1', { name: 'Renamed' });
    assert.equal(r.ok, true);
    assert.equal('folderId' in written!, false);
  });

  it('moves the skill into a same-department folder', async () => {
    let written: Record<string, unknown> | null = null;
    const svc = makeService({
      existingSkill: existing,
      folder: { departmentId: DEPT.id, status: 'active' },
      onWrite: (d) => { written = d; },
    });
    const r = await svc.updateSkill(DEPT.id, 'co-1', 'sk-1', 'u-1', { folderId: 'f-2' });
    assert.equal(r.ok, true);
    assert.equal(written!['folderId'], 'f-2');
  });

  it('detaches to root when folderId is explicitly null', async () => {
    let written: Record<string, unknown> | null = null;
    const svc = makeService({ existingSkill: existing, onWrite: (d) => { written = d; } });
    const r = await svc.updateSkill(DEPT.id, 'co-1', 'sk-1', 'u-1', { folderId: null });
    assert.equal(r.ok, true);
    assert.equal(written!['folderId'], null);
  });

  it("rejects moving into another department's folder", async () => {
    const svc = makeService({
      existingSkill: existing,
      folder: { departmentId: 'dep-sales', status: 'active' },
    });
    const r = await svc.updateSkill(DEPT.id, 'co-1', 'sk-1', 'u-1', { folderId: 'f-2' });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
  });

  it('rejects an update that introduces Chinese into a Lark skill', async () => {
    let wrote = false;
    const svc = makeService({
      existingSkill: {
        ...existing,
        slug: 'lark-documents',
        name: 'Lark Documents',
        toolIds: ['larkDoc'],
        tags: ['lark'],
      },
      onWrite: () => { wrote = true; },
    });
    const r = await svc.updateSkill(DEPT.id, 'co-1', 'sk-1', 'u-1', {
      markdown: '# Lark Documents\n\n创建文档。',
    });

    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error.kind, 'validation');
    assert.equal(wrote, false);
  });
});
