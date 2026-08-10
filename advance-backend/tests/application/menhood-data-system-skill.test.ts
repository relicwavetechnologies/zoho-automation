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
    /*
     * "one SELECT or read-only WITH", bound parameters, the table allow-list,
     * and the deterministic ORDER BY example are all stated by the menhoodData
     * tool's own parameterDocs. The skill keeps what the tool cannot say: that
     * this analysis never goes through local Python, and why stable ordering
     * matters — a sample is only reviewable if the full replay matches it.
     */
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never interpolate|ORDER BY o\.order_date/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /never .*route Menhood analysis through local Python/i);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /only reviewable if the full replay returns rows in the same order/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Context first, then query/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /SELECT \* FROM menhood_orders LIMIT 0/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /order-line grain/);
    // The tool's parameterDocs declare the table unavailable. The skill owns
    // the consequence: no spend claim sourced from somewhere else instead.
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /`menhood_advertisement_costs` is unavailable/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /bounded preview/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Choose `final_amount`, `collectable_value`, or `declared_value`/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Never page bulk rows through the conversation/);
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /exportCandidate|dataExport/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /deterministic `ORDER BY`/);
    // The exact column list is the tool's example; the skill keeps the reason.
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /sample is only reviewable if the full replay returns rows in the same order/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /current-month, and previous-month questions before reporting maturity cannot be answered here as final numbers/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /do not ask whether to check live data/);
    assert.match(MENHOOD_DATA_SYSTEM_SKILL.markdown, /Load `airtable-core` immediately and use the live Airtable Orders table yourself/);
  });

  it('hands the exact requested window to Airtable instead of a relative one', () => {
    // A July question that reached Airtable as `pastMonth` counted a rolling
    // 30-day window and reported a total that was never July's.
    assert.match(
      MENHOOD_DATA_SYSTEM_SKILL.markdown,
      /Carry the member's exact requested window into that filter/,
    );
    assert.match(
      MENHOOD_DATA_SYSTEM_SKILL.markdown,
      /explicit start and end bounds in Asia\/Kolkata/,
    );
    assert.match(
      MENHOOD_DATA_SYSTEM_SKILL.markdown,
      /never a relative window such as `pastMonth` or `thisCalendarMonth`/,
    );
    assert.match(
      MENHOOD_DATA_SYSTEM_SKILL.markdown,
      /Read the count from Airtable's `metadata\.totalRecordCount` rather than from the preview rows/,
    );
    // The old escape hatch let a truncated live read bounce back to a question.
    // Every live read is truncated, so it fired on the happy path.
    assert.doesNotMatch(MENHOOD_DATA_SYSTEM_SKILL.markdown, /or the live read is truncated/);
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
    assert.match(cookbook, /query the live Airtable Orders table yourself; do not ask permission first/);
    assert.match(cookbook, /Do not approximate these filters with `order_status`/);
    assert.match(cookbook, /Grouped `order_status` and `payment_type` counts are order-line buckets/);
    assert.match(cookbook, /final-amount\/gross order value/);
    assert.match(cookbook, /do not silently call it “revenue”/);
    assert.match(cookbook, /trim.*remove non-digits.*six-digit.*join/s);
    // The tool states the table is unavailable; the skill states the
    // consequence it cannot -- do not source that claim from anywhere else.
    assert.match(cookbook, /never make advertising-cost, ROAS, or spend claims/);
    assert.match(cookbook, /not from another table, and not from memory/);
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
    assert.match(router!.markdown, /Route there immediately; do not first sample the reporting DB and do not ask whether to check Airtable/);
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
