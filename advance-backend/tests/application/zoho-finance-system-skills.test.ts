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
      [
        'finance-zoho-router',
        'zoho-crm-read-analysis',
      'zoho-books-read-analysis',
      'zoho-books-invoice',
      'zoho-books-purchase-order',
      'zoho-books-money',
        'zoho-books-bill',
        'zoho-bill-notify-accounts',
      ],
    );
  });

  it('provisions every specialist referenced by the Finance router', () => {
    const router = ZOHO_FINANCE_SYSTEM_SKILLS.find(skill => skill.slug === 'finance-zoho-router');
    assert.ok(router);
    const provisionedSlugs = new Set(ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => skill.slug));
    const referencedSlugs = [...router.markdown.matchAll(/load `([^`]+)`/g)]
      .map(match => match[1]);

    assert.ok(referencedSlugs.length > 0);
    assert.deepEqual(referencedSlugs.filter(slug => !provisionedSlugs.has(slug)), []);
  });

  it('keeps the read specialist truthful about exact lookups and reported figures', () => {
    const specialist = ZOHO_FINANCE_SYSTEM_SKILLS.find(
      skill => skill.slug === 'zoho-books-read-analysis',
    );
    assert.ok(specialist);
    assert.deepEqual(specialist.toolIds, ['zohoBooks']);
    assert.match(specialist.markdown, /exact normalized invoice_number match/i);
    assert.match(specialist.markdown, /never substitute a fuzzy result/i);
    assert.match(specialist.markdown, /Preserve Zoho identifiers exactly as returned/i);
    assert.match(specialist.markdown, /Do not add uncomputed remainders/i);
    /*
     * Newest-first ordering, the row-field contract, and the UNKNOWN-currency
     * rule describe what zohoBooks returns. The tool's own docs state all
     * three, and tests/tools/zoho-books.tool.test.ts asserts them there.
     */
    assert.doesNotMatch(specialist.markdown, /sorted by invoice date newest-first/i);
    assert.doesNotMatch(specialist.markdown, /_amount_inr|_balance_inr|_currency/);
  });

  it('asks only when the requested Zoho service still has multiple eligible accounts', () => {
    const specialist = ZOHO_FINANCE_SYSTEM_SKILLS.find(
      skill => skill.slug === 'zoho-crm-read-analysis',
    );
    assert.ok(specialist);
    assert.match(specialist.markdown, /first restrict them to the requested service/i);
    assert.match(specialist.markdown, /ask the member only when multiple accounts list the requested service/i);
    assert.match(specialist.markdown, /use `search` with provider-side criteria/i);
    assert.match(specialist.markdown, /`list` does not accept criteria/i);
  });

  /*
   * Every specialist embeds the same connection preamble, so one duplicated
   * sentence there is six in the catalogue. This guards the reverse direction
   * of the compression: no skill may restate what a Zoho tool's schema and
   * parameterDocs already carry.
   */
  it('never reprints a Zoho tool contract across the family', () => {
    for (const skill of ZOHO_FINANCE_SYSTEM_SKILLS) {
      assert.doesNotMatch(skill.markdown, /payment_terms_label|supersedesStagingId|review\.attemptsRemaining/);
      assert.doesNotMatch(skill.markdown, /takes ONLY stagingId|requires a stagingId/);
      assert.doesNotMatch(skill.markdown, /limit \(1-100\)|page \(1-\d+\)/);
    }
  });

  it('creates department-scoped skills directly under Finance and grants the department', async () => {
    const createdSkills: Record<string, unknown>[] = [];
    const grants: Record<string, unknown>[] = [];
    const aliasWrites: Array<{ skillId: string; alias: string }> = [];
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
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: Array<{ skillId: string; alias: string }> }) => {
          aliasWrites.push(...data);
          return { count: data.length };
        },
      },
      skillAccessGrant: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          grants.push(create);
          return create;
        },
      },
    } as any;

    const result = await provisionZohoFinanceSystemSkills(db, 'company-1');

    // Router search never scores markdown, so a family with no aliases is a
    // family that cannot be found by the words members actually type.
    assert.ok(aliasWrites.length > 0);
    for (const definition of ZOHO_FINANCE_SYSTEM_SKILLS) {
      assert.ok(definition.aliases.length > 0, `${definition.slug} has no aliases`);
    }
    assert.ok(aliasWrites.some(alias => alias.alias === 'create an invoice'));

    assert.deepEqual(result, {
      departmentId: 'finance-dept',
      created: ZOHO_FINANCE_SYSTEM_SKILLS.length,
      updated: 0,
      existing: 0,
      skipped: 0,
      skippedSlugs: [],
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
      skippedSlugs: ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => skill.slug),
    });
  });
});
