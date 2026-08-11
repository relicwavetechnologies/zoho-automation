import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MENHOOD_DATA_SKILL_SLUG,
  MENHOOD_DATA_SYSTEM_SKILL,
  provisionMenhoodDataSystemSkill,
} from '../../src/application/skills/menhood-data-system-skill';
import {
  ROUTING_SYSTEM_SKILLS,
  SYSTEM_SKILL_ROUTE_SEEDS,
} from '../../src/application/skills/system-skill-routes';
import { REGISTERED_TOOL_SEEDS } from '../../scripts/seed-registered-tools';

describe('Menhood data system skill', () => {
  it('keeps the specialist read-only, bounded, and separate from Airtable connections', () => {
    assert.deepEqual(MENHOOD_DATA_SYSTEM_SKILL.toolIds, ['menhoodData']);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /needs no Airtable connection ID/);
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never interpolate|ORDER BY o\.order_date/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Query only through `menhoodData`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /SELECT \* FROM menhood_orders LIMIT 1/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /tool rejects zero-row limits/);
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /LIMIT 0/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /order-line grain/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /`menhood_advertisement_costs` is unavailable/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /respect `coverage\.truncated`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Choose `final_amount`, `collectable_value`, or `declared_value`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Never move bulk rows through chat/);
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /exportCandidate|dataExport/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Keep row-level previews deterministic/);
  });

  it('routes immature windows and named products through the live canonical-SKU path', () => {
    const markdown = MENHOOD_DATA_SYSTEM_SKILL.markdown;
    assert.match(markdown, /after `maturedThrough` is incomplete, not final/);
    assert.match(markdown, /“current”, “latest”, or “live” as a decisive pre-query route/);
    assert.match(markdown, /do not query `menhood_orders` for the final metric/);
    assert.match(markdown, /end date is later than `maturedThrough`/);
    assert.match(markdown, /Carry exact Asia\/Kolkata date bounds/);
    assert.match(markdown, /take its canonical `product_sku`; then filter Airtable's SKU field/);
    assert.match(markdown, /Product Name is only a display label/);
    assert.match(markdown, /multiple distinct SKUs/);
    assert.match(markdown, /do not probe `menhood_orders`/);
    assert.match(markdown, /complete live\/current export or Google Sheet/);
    assert.match(markdown, /`airtable-core`, `divo-python-automation`, and `google-sheets`/);
    assert.match(markdown, /Do not load `create-edit-files` for a Lark or Google Sheets delivery/);
    assert.match(markdown, /retired export tool, candidate, or offer flow/);
    assert.match(markdown, /sale totals include customer-requested add-on rows/);
    assert.match(markdown, /`Order Sub Status` = Add New Item or Added New Item along with Regular Order/);
    assert.match(markdown, /Do not say "Regular Order only"/);
    assert.match(markdown, /delivered after reshipment/);
    assert.match(markdown, /order numbers ending in RSP/);
  });

  it('keeps durable metric, join, freshness, and privacy invariants without snapshot trivia', () => {
    const cookbook = MENHOOD_DATA_SYSTEM_SKILL.markdown;

    for (const invariant of [
      'menhood_orders.customer_id = menhood_customers.id',
      'menhood_orders.product_id = menhood_products.id',
      'menhood_customers.customer_name',
      'menhood_products.product_name',
      '`COUNT(DISTINCT order_number)`',
      '`SUM(quantity)`',
      'Delivered, Cancelled, and RTO Delivered',
      'COD and PREPAID',
      'final-amount/gross order value',
      'customer email, phone, WhatsApp, and addresses as PII',
    ]) {
      assert.ok(cookbook.includes(invariant), `missing cookbook invariant: ${invariant}`);
    }
    assert.match(cookbook, /`Order Status \(Team\)`/);
    assert.match(cookbook, /`Order Sub Status`/);
    assert.match(cookbook, /Duplicate\/TEST\/Testing/);
    assert.match(cookbook, /after `ordersThrough` is out of range, not zero/);
    assert.doesNotMatch(cookbook, /160,713|134,418|5,834|107131011|0999-01-01/);
  });

  it('prioritizes Menhood analytics without changing ordinary Airtable routes', () => {
    const routes = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'airtable-router');
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'airtable-router');

    assert.ok(routes);
    assert.equal(routes.targetSlugs[0], MENHOOD_DATA_SKILL_SLUG);
    assert.ok(routes.targetSlugs.includes('divo-python-automation'));
    assert.ok(routes.targetSlugs.includes('airtable-core'));
    assert.ok(routes.targetSlugs.includes('airtable-schema-ops'));
    assert.ok(routes.targetSlugs.includes('airtable-automation-ops'));
    assert.match(router!.markdown, /SQL joins, aggregates, or cohorts/);
    assert.match(router!.markdown, /Current\/latest Menhood facts or Airtable-only operational semantics/);
    assert.match(router!.markdown, /resolve its canonical SKU/);
    assert.match(router!.markdown, /complete current\/live calculation or artifact/);
    assert.match(router!.markdown, /sale totals include customer-requested add-on rows/);
    assert.match(router!.markdown, /Add New Item or Added New Item along with Regular\s+Order/);
    assert.match(router!.markdown, /reship\/RSP delivered variants/);
    assert.match(router!.markdown, /never scan the full Orders table before trying server-side filters/);
    assert.match(router!.markdown, /Ordinary Airtable records, comments, and CRUD/);
    assert.match(router!.markdown, /Interfaces, forms, and automations/);
    for (const alias of ['orders', 'customers', 'products', 'sales analysis', 'rto analysis', 'cod analysis']) {
      assert.ok(router!.aliases.includes(alias), `missing Airtable router alias: ${alias}`);
    }
  });

  it('seeds a non-HITL backend-managed catalogue entry', () => {
    const seed = REGISTERED_TOOL_SEEDS.find(candidate => candidate.toolId === 'menhoodData');

    assert.ok(seed);
    assert.equal(seed.domain, 'menhood');
    assert.equal(seed.hitlRequired, undefined);
    assert.ok(seed.guardrails?.some(guardrail => guardrail.includes('bound parameters')));
  });

  it('provisions a company-wide system skill through the shared reconciler', async () => {
    const created: Record<string, unknown>[] = [];
    const db = {
      skillFolder: { findFirst: async () => null, upsert: async () => ({ id: 'folder-1' }) },
      skill: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { ...data, revision: 1, createdBy: null, updatedBy: null, aliases: [] };
          created.push(row);
          return row;
        },
        update: async () => { throw new Error('unexpected update'); },
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: { upsert: async () => ({}) },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      },
    } as never;

    const result = await provisionMenhoodDataSystemSkill(db, 'company-1');

    assert.equal(result.outcome, 'created');
    assert.equal(created[0]?.slug, MENHOOD_DATA_SKILL_SLUG);
    assert.equal(created[0]?.scope, 'company');
    assert.equal(created[0]?.isSystem, true);
  });
});
