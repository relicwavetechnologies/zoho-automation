import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

export const MENHOOD_DATA_SKILL_SLUG = 'menhood-data';

export const MENHOOD_DATA_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: MENHOOD_DATA_SKILL_SLUG,
  name: 'Menhood Data',
  summary: 'Query the company-managed Menhood Airtable sync for filtered order, customer, product, and location analysis.',
  markdown: `# Menhood Data

Use this skill for analytical questions over the company-managed Menhood Airtable sync. It needs no Airtable connection ID.

## Query discipline

1. Query only through the Divo \`menhoodData\` tool. Never connect to PostgreSQL directly, expose database details, or route Menhood analysis through local Python.
2. Send one \`SELECT\` or read-only \`WITH ... SELECT\`. Put every user value in bound parameters such as \`$1\`; never interpolate it into SQL.
3. Use only \`menhood_orders\`, \`menhood_customers\`, \`menhood_products\`, and \`all_cities_with_pincode\`. \`menhood_advertisement_costs\` is intentionally unavailable: never query it or make advertising-cost, ROAS, or spend claims from it.
4. Keep chat results to the bounded preview and disclose \`coverage.truncated\`. Never page bulk rows through the conversation or synthesize an export offer. If a later tool result contains \`preview.exportOfferId\`, preserve that opaque offer for Divo's private Sheet/CSV/XLSX choice. If the member later names a format, call \`dataExport\` with \`op=confirm\`; never rerun the query or route it to Python.

## Data model and quality

- \`menhood_orders\` is order-line grain: the observed 160,713 rows represent 134,418 distinct \`order_number\` values. Count \`DISTINCT order_number\` for orders; use raw rows only for line, quantity, or value aggregation.
- \`menhood_customers\` is one customer per \`id\`; \`menhood_products\` is one product per \`id\`, not per SKU. \`all_cities_with_pincode\` is lookup-row grain and has 22 observed repeated trimmed pincodes, so aggregate the lookup before joining when one row per pincode is required.
- Join \`menhood_orders.customer_id = menhood_customers.id\` and \`menhood_orders.product_id = menhood_products.id\`. Do not join products by SKU: 62 observed order lines lack \`product_id\`, 5,834 linked lines disagree with \`product_sku\`, and the product table has 11 duplicate normalized-SKU groups.
- Grouped \`order_status\` and \`payment_type\` counts are order-line buckets: the same \`order_number\` can appear in more than one bucket. Do not call them a mutually exclusive distribution or make the percentages imply that the buckets sum to total orders; say “orders with at least one matching line” when that is what was counted.
- For the city lookup, trim the customer and lookup pincodes, remove non-digits, retain only six-digit values, and then join them. Keep pincodes as text so a leading zero is not lost; report excluded invalid values rather than guessing them.
- Treat \`order_status\` values exactly as \`Delivered\`, \`Cancelled\`, and \`RTO Delivered\`; keep null as Unknown. Treat \`payment_type\` exactly as \`COD\` or \`PREPAID\`; keep null as Unknown rather than assigning it to either side.
- Choose \`final_amount\`, \`collectable_value\`, or \`declared_value\` from the member's wording. State the selected meaning when material. Label a \`SUM(final_amount)\` precisely as final-amount/gross order value unless the member defines it as revenue; do not silently call it “revenue” across cancelled or unknown statuses. Ask one short question only when genuinely ambiguous.
- \`utm_source\`, \`utm_medium\`, and \`utm_campaign\` are incomplete. Always show matched and missing coverage; never relabel missing attribution as direct or organic. Use only order attribution fields, never advertisement costs.
- One observed customer \`createdAt\` is \`0999-01-01\`. Exclude customer dates before 2000 from date/cohort calculations and report the exclusion; prefer the customer's first valid \`order_date\` for acquisition cohorts.

## Recipes

- Daily/monthly orders and delivered value: group valid \`order_date\`, count distinct orders, filter the exact status, and aggregate the selected value across its order lines.
- Product/SKU performance: group by \`product_id\`, join the product name, sum quantity/value, and retain missing product IDs as Unknown; never repair the join with SKU.
- Repeat customers and cohorts: count distinct orders per \`customer_id\`; derive acquisition from first valid order date, then group later orders by cohort period.
- COD versus prepaid and shipping-partner delivery/RTO: keep Unknown buckets, count distinct orders by exact status, and report rates with denominators.
- Coupon performance: compare nonblank \`coupon_code\` with an explicit no-coupon bucket using distinct orders and the selected value.
- UTM/campaign attribution: group the three UTM fields from orders, preserve an Unknown bucket, and show attribution coverage beside totals.
- City/state/pincode demand: join customers through normalized six-digit pincode, keep unmatched customers visible, and count distinct orders.
- Data-quality diagnostics: report null join keys, unmatched IDs, duplicate product SKUs, SKU disagreements, missing UTM/payment/status values, invalid pincodes, and pre-2000 customer dates without exposing PII.

Treat observed counts above as known snapshot risks; recompute them when the member asks for current data-quality coverage.

Ordinary Airtable record CRUD, schema changes, interfaces, forms, and automations remain with their existing Airtable specialists.

Answer in business language, not as raw SQL or database plumbing.`,
  toolIds: ['menhoodData'],
  tags: ['divo', 'airtable', 'menhood', 'orders', 'customers', 'products', 'analytics'],
  aliases: [
    'menhood',
    'menhood data',
    'company airtable sync',
    'menhood orders',
    'menhood customers',
    'menhood products',
    'orders',
    'customers',
    'products',
    'sales analysis',
    'rto analysis',
    'cod analysis',
    'campaign analysis',
    'pincode analysis',
  ],
  sortOrder: 35,
};

type MenhoodSkillStore = Pick<
  Prisma.TransactionClient,
  'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
>;

export function provisionMenhoodDataSystemSkill(db: MenhoodSkillStore, companyId: string) {
  return provisionDivoProductivitySystemSkill(db, companyId, MENHOOD_DATA_SYSTEM_SKILL);
}

export function provisionMenhoodDataForExistingCompanies(
  db: Pick<PrismaClient, 'company'> & MenhoodSkillStore,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, MENHOOD_DATA_SYSTEM_SKILL);
}
