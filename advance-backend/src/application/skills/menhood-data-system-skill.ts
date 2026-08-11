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
  summary: 'Query settled Menhood reporting data and route current operational questions to live Airtable.',
  markdown: `# Menhood Data

Use this for settled analytical questions over the company-managed Menhood reporting data. It needs no Airtable connection ID.

## Choose the source before querying

- Read every result's \`freshness.ordersThrough\` and \`freshness.maturedThrough\`.
- Use this reporting source for settled historical joins, aggregates, cohorts, product performance, RTO/COD, campaign, and pincode analysis.
- A window after \`ordersThrough\` is out of range, not zero. A window after \`maturedThrough\` is incomplete, not final.
- Treat “current”, “latest”, or “live” as a decisive pre-query route: do not query \`menhood_orders\` for the final metric. Use this source only to resolve product identity, then load \`airtable-core\` and query the live Orders table.
- Apply the same live route whenever the request's end date is later than \`maturedThrough\`; that window overlaps data still arriving. Carry exact Asia/Kolkata date bounds and never replace a named month with a rolling window.
- Airtable-only fields such as Regular Order, \`Order Status (Team)\`, \`Order Sub Status\`, and Duplicate/TEST/Testing always use the live route.
- For a current/live request naming a product, first resolve the catalog row here and take its canonical \`product_sku\`; then filter Airtable's SKU field. Airtable Product Name is only a display label and may contain aliases or duplicate choices. Ask only if the catalog produces multiple distinct SKUs.
- For that live route, query only the needed \`menhood_products.product_name\` and \`product_sku\`; do not probe \`menhood_orders\`, because live Airtable supplies the requested order facts.

## Query discipline

1. Query only through \`menhoodData\`. Never connect directly to PostgreSQL or expose database details.
2. Probe unfamiliar tables or columns once with a one-row bounded preview such as \`SELECT * FROM menhood_orders LIMIT 1\`, then issue one corrected query. The tool rejects zero-row limits. Do not loop after a second failure.
3. Keep row-level previews deterministic and respect \`coverage.truncated\`. Never move bulk rows through chat.
4. \`menhood_advertisement_costs\` is unavailable. Do not make ad-spend or ROAS claims from this source or from memory.

## Metric and data rules

- \`menhood_orders\` is order-line grain. Orders = \`COUNT(DISTINCT order_number)\`; units = \`SUM(quantity)\`; values sum the member's chosen amount field.
- Join customers and products by IDs: \`menhood_orders.customer_id = menhood_customers.id\` and \`menhood_orders.product_id = menhood_products.id\`. Do not repair missing or conflicting product links by joining on SKU.
- Product identity lives in \`menhood_products.product_name\` and \`product_sku\`; customer display names live in \`menhood_customers.customer_name\`. Probe any other field before use.
- Preserve Unknown/null buckets. Grouped status or payment counts are line buckets unless the query explicitly counts distinct orders.
- Use exact status values such as Delivered, Cancelled, and RTO Delivered; use exact payment values COD and PREPAID.
- Choose \`final_amount\`, \`collectable_value\`, or \`declared_value\` from the request. Label \`SUM(final_amount)\` as final-amount/gross order value unless the member defines revenue differently.
- UTM fields are incomplete. Report matched and missing coverage; never relabel missing attribution as direct or organic.
- Treat customer email, phone, WhatsApp, and addresses as PII. Return them only when explicitly requested and authorized.
- Normalize pincodes to six-digit text before joining city/state lookup data; retain unmatched and invalid values as disclosed exclusions.

## Completion

- State the source and freshness boundary whenever it affects the answer.
- Report the exact metric grain: order lines, distinct orders, units, or selected value.
- Answer in business language, not raw SQL or database plumbing.
- Ordinary Airtable CRUD, schema, interfaces, forms, and automations remain with their Airtable specialists.`,
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
