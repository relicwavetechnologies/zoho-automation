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
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /one `SELECT` or read-only `WITH \.\.\. SELECT`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /bound parameters/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Context first, then query/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /SELECT \* FROM menhood_orders LIMIT 0/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /order-line grain/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /`menhood_advertisement_costs` is intentionally unavailable/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /bounded preview/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Choose `final_amount`, `collectable_value`, or `declared_value`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Never page bulk rows.*synthesize an export/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /result contains `exportCandidate`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /call `dataExport` with `op=plan`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Want me to export this to Google Sheets, Excel, or CSV/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /not to export, not now, or chat-only/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /deterministic `ORDER BY`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /ORDER BY o\.order_date, o\.order_number, o\.id/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /sample is only reviewable if the full replay returns rows in the same order/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /current-month, and previous-month questions before reporting maturity cannot be answered here as final numbers/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /use the live Airtable Orders table instead/);
  });

  it('contains the operational joins, enums, quality rules, and named recipes', () => {
    const cookbook = MENHOOD_DATA_SYSTEM_SKILL.markdown;

    for (const invariant of [
      'menhood_orders.customer_id = menhood_customers.id',
      'menhood_orders.product_id = menhood_products.id',
      'menhood_customers.customer_name',
      'menhood_products.product_name',
      'Count `DISTINCT order_number` for orders',
      '`menhood_customers` is one customer per `id`',
      '`menhood_products` is one product per `id`, not per SKU',
      '`all_cities_with_pincode` is lookup-row grain',
      '`Delivered`, `Cancelled`, and `RTO Delivered`',
      '`COD` or `PREPAID`',
      'keep null as Unknown',
      '11 duplicate normalized-SKU groups',
      '`utm_source`, `utm_medium`, and `utm_campaign` are incomplete',
      'Copy large numeric strings from `menhoodData` rows exactly in tables',
      'show `107131011`, not `1,07,13,1011`',
      '`0999-01-01`',
      'Daily/monthly orders and delivered value',
      'Product/SKU performance',
      'Repeat customers and cohorts',
      'COD versus prepaid and shipping-partner delivery/RTO',
      'Coupon performance',
      'UTM/campaign attribution',
      'City/state/pincode demand',
      'Data-quality diagnostics',
    ]) {
      assert.ok(cookbook.includes(invariant), `missing cookbook invariant: ${invariant}`);
    }
    assert.match(cookbook, /does \*\*not\*\* contain Airtable view\/cleanup fields/);
    assert.match(cookbook, /`Order Status \(Team\)`/);
    assert.match(cookbook, /`Order Sub Status`/);
    assert.match(cookbook, /Duplicate\/TEST\/Testing/);
    assert.match(cookbook, /Do not approximate these filters with `order_status`/);
    assert.match(cookbook, /Grouped `order_status` and `payment_type` counts are order-line buckets/);
    assert.match(cookbook, /final-amount\/gross order value/);
    assert.match(cookbook, /do not silently call it “revenue”/);
    assert.match(cookbook, /trim.*remove non-digits.*six-digit.*join/s);
    assert.match(cookbook, /`menhood_advertisement_costs` is intentionally unavailable/);
    assert.match(cookbook, /never query it or make advertising-cost, ROAS, or spend claims/);
    assert.match(cookbook, /Make at most one schema\/context probe and one corrected retry/);
  });

  it('prioritizes Menhood analytics without changing ordinary Airtable routes', () => {
    const routes = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'airtable-router');
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'airtable-router');

    assert.ok(routes);
    assert.equal(routes.targetSlugs[0], MENHOOD_DATA_SKILL_SLUG);
    assert.ok(routes.targetSlugs.includes('airtable-core'));
    assert.ok(routes.targetSlugs.includes('airtable-schema-ops'));
    assert.ok(routes.targetSlugs.includes('airtable-automation-ops'));
    assert.match(router!.markdown, /joins, aggregates, cohorts, broad filtering, or bulk analysis/);
    assert.match(router!.markdown, /Current\/latest Menhood order counts/);
    assert.match(router!.markdown, /Duplicate\/TEST\/Testing cleanup/);
    assert.match(router!.markdown, /Do not route broad historical analytics or full exports through\s+Airtable MCP/);
    assert.match(router!.markdown, /does not use local Python/);
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
