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
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /order-line grain/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /`menhood_advertisement_costs` is intentionally unavailable/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /bounded preview/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Choose `final_amount`, `collectable_value`, or `declared_value`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Never page bulk rows.*synthesize an export offer/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /If a later tool result contains `preview\.exportOfferId`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /preserve only that one opaque offer/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /do not ask again, call another export tool, or route it to Python/);
  });

  it('contains the operational joins, enums, quality rules, and named recipes', () => {
    const cookbook = MENHOOD_DATA_SYSTEM_SKILL.markdown;

    for (const invariant of [
      'menhood_orders.customer_id = menhood_customers.id',
      'menhood_orders.product_id = menhood_products.id',
      'Count `DISTINCT order_number` for orders',
      '`menhood_customers` is one customer per `id`',
      '`menhood_products` is one product per `id`, not per SKU',
      '`all_cities_with_pincode` is lookup-row grain',
      '`Delivered`, `Cancelled`, and `RTO Delivered`',
      '`COD` or `PREPAID`',
      'keep null as Unknown',
      '11 duplicate normalized-SKU groups',
      '`utm_source`, `utm_medium`, and `utm_campaign` are incomplete',
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
    assert.match(cookbook, /Grouped `order_status` and `payment_type` counts are order-line buckets/);
    assert.match(cookbook, /final-amount\/gross order value/);
    assert.match(cookbook, /do not silently call it “revenue”/);
    assert.match(cookbook, /trim.*remove non-digits.*six-digit.*join/s);
    assert.match(cookbook, /`menhood_advertisement_costs` is intentionally unavailable/);
    assert.match(cookbook, /never query it or make advertising-cost, ROAS, or spend claims/);
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
