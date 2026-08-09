/**
 * Whether a member asking to create an invoice can reach the Finance router.
 *
 * Router search scores slug, name and tags at 5, an alias term at 4, an exact
 * alias phrase at 10, and the summary at 2. Markdown is never scored. The Zoho
 * family was the only one provisioned with no aliases at all, so "create an
 * invoice for Acme Ltd" matched nothing in it, scored zero, and fell into the
 * alphabetical tail where a three-result limit cut it off.
 *
 * These tests run the real scorer through the real service, so they fail if the
 * aliases stop being provisioned rather than if a constant is edited.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SkillCatalogService } from '../../src/application/skills/skill-catalog.service.ts';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from '../../src/application/skills/zoho-finance-system-skills.ts';
import { asToolId } from '../../src/shared/ids.ts';

const noopLogger: any = {
  child: () => noopLogger,
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

/** The other routers a finance question competes with, named as they really are. */
const OTHER_ROUTERS = [
  'Airtable Router', 'Aitable Router', 'Data & Processing Router',
  'Files & Documents Router', 'Google Workspace Router', 'Lark Router',
  'Research Router', 'Shopify Router',
];

function makeCatalog() {
  const zohoRouter = ZOHO_FINANCE_SYSTEM_SKILLS.find(s => s.slug === 'finance-zoho-router')!;

  const rows = [
    {
      id: 'zoho-router-id',
      slug: zohoRouter.slug,
      name: zohoRouter.name,
      summary: zohoRouter.summary,
      markdown: zohoRouter.markdown,
      toolIds: [],
      tags: [...zohoRouter.tags],
      aliases: [...zohoRouter.aliases],
      revision: 1,
    },
    {
      id: 'zoho-books-id',
      slug: 'zoho-books-read-analysis',
      name: 'Zoho Books Read and Analysis',
      summary: 'Read Zoho Books',
      markdown: '',
      toolIds: ['zohoBooks'],
      tags: ['zoho', 'books'],
      aliases: ['invoice'],
      revision: 1,
    },
    ...OTHER_ROUTERS.map((name, index) => ({
      id: `other-${index}`,
      slug: name.toLowerCase().replace(/[^a-z]+/g, '-'),
      name,
      summary: `Routes ${name} work to the exact specialist.`,
      markdown: '',
      toolIds: [],
      tags: ['router'],
      aliases: [],
      revision: 1,
    })),
  ];

  return new SkillCatalogService({
    repo: {
      list: async () => ({ ok: true, value: rows }),
      listRouteTargets: async ({ routerSkillId }: { routerSkillId: string }) => ({
        ok: true,
        value: routerSkillId === 'zoho-router-id' ? [rows[1]] : [],
      }),
    } as any,
    logger: noopLogger,
  });
}

const permission: any = {
  allowedToolIds: new Set([asToolId('zohoBooks'), asToolId('zohoCrm')]),
  allowedActionsByTool: new Map(),
};

async function topRouters(query: string, limit = 3) {
  const results = await makeCatalog().searchVisibleRouters({
    companyId: 'company-1', permission, query, limit,
  });
  return results.map(result => result.slug);
}

describe('Finance router discovery', () => {
  it('surfaces the Finance router for a request to create an invoice', async () => {
    // The exact phrasing from the audit. Before aliases this scored 0 and was
    // ranked below Airtable, Aitable, Data and Files purely by name order.
    assert.equal((await topRouters('create an invoice for Acme Ltd'))[0], 'finance-zoho-router');
  });

  it('surfaces it for the other ways members ask to bill someone', async () => {
    for (const query of [
      'raise an invoice',
      'send an invoice to the client',
      'bill a customer for last month',
      'record a bill from this PDF',
      'what are our unpaid invoices',
      'show me the aging report',
    ]) {
      assert.equal(
        (await topRouters(query))[0],
        'finance-zoho-router',
        `"${query}" did not reach the finance router`,
      );
    }
  });

  it('does not claim finance work that belongs to another router', async () => {
    const slugs = await topRouters('upload this file to google drive');
    assert.equal(slugs[0] === 'finance-zoho-router', false);
  });

  it('gives every provisioned Zoho skill at least one alias', async () => {
    for (const definition of ZOHO_FINANCE_SYSTEM_SKILLS) {
      assert.ok(
        definition.aliases.length > 0,
        `${definition.slug} has no aliases, so nothing but its name and tags can find it`,
      );
    }
  });
});
