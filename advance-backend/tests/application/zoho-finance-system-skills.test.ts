import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ZOHO_FINANCE_SYSTEM_SKILLS,
  provisionZohoFinanceSystemSkills,
} from '../../src/application/skills/zoho-finance-system-skills.ts';

describe('Zoho Finance system skill provisioning', () => {
  it('defines the complete source-controlled Finance workflow set', () => {
    assert.deepEqual(
      ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => skill.slug),
      ['finance-ops-core', 'zoho-books-bill', 'zoho-bill-notify-accounts'],
    );
  });

  it('creates department-scoped skills directly under Finance and grants the department', async () => {
    const createdSkills: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const versions: Record<string, unknown>[] = [];
    const db = {
      department: {
        findMany: async () => [{ id: 'finance-dept', name: 'Finance', slug: 'finance' }],
      },
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, revision: 1, createdBy: null, updatedBy: null };
          createdSkills.push(row);
          return row;
        },
        update: async () => { throw new Error('unexpected update'); },
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

    const result = await provisionZohoFinanceSystemSkills(db, 'company-1');

    assert.deepEqual(result, {
      departmentId: 'finance-dept',
      created: ZOHO_FINANCE_SYSTEM_SKILLS.length,
      updated: 0,
      existing: 0,
      skipped: 0,
    });
    assert.deepEqual(
      createdSkills.map(skill => ({
        slug: skill.slug,
        departmentId: skill.departmentId,
        folderId: skill.folderId,
        scope: skill.scope,
        isSystem: skill.isSystem,
      })),
      ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => ({
        slug: skill.slug,
        departmentId: 'finance-dept',
        folderId: null,
        scope: 'department',
        isSystem: true,
      })),
    );
    assert.equal(versions.length, ZOHO_FINANCE_SYSTEM_SKILLS.length);
    assert.deepEqual(
      grants.map(grant => ({ granteeType: grant.granteeType, granteeId: grant.granteeId })),
      ZOHO_FINANCE_SYSTEM_SKILLS.map(() => ({
        granteeType: 'department',
        granteeId: 'finance-dept',
      })),
    );
  });

  it('preserves non-system skills with reserved slugs without changing their grants', async () => {
    let grants = 0;
    const db = {
      department: {
        findMany: async () => [{ id: 'finance-dept', name: 'Finance', slug: 'finance' }],
      },
      skill: { findFirst: async () => ({ id: 'custom', isSystem: false }) },
      skillAccessGrant: { upsert: async () => { grants += 1; } },
    } as any;

    const result = await provisionZohoFinanceSystemSkills(db, 'company-1');

    assert.equal(result.skipped, ZOHO_FINANCE_SYSTEM_SKILLS.length);
    assert.equal(grants, 0);
  });

  it('fails closed when the company has no Finance-like department', async () => {
    const db = {
      department: { findMany: async () => [{ id: 'eng', name: 'Engineering', slug: 'engineering' }] },
    } as any;

    const result = await provisionZohoFinanceSystemSkills(db, 'company-1');

    assert.deepEqual(result, {
      departmentId: null,
      created: 0,
      updated: 0,
      existing: 0,
      skipped: ZOHO_FINANCE_SYSTEM_SKILLS.length,
    });
  });
});
