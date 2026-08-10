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
3. Context first, then query. If the answer needs a join, an unfamiliar column, or any field you have not already observed in this run, first call \`menhoodData\` with a zero-row schema probe such as \`SELECT * FROM menhood_orders LIMIT 0\` for each needed table, or a tiny single-table preview. Build the real query from the returned column names.
4. Use only \`menhood_orders\`, \`menhood_customers\`, \`menhood_products\`, and \`all_cities_with_pincode\`. \`menhood_advertisement_costs\` is intentionally unavailable: never query it or make advertising-cost, ROAS, or spend claims from it.
5. Keep chat results to the bounded preview and disclose \`coverage.truncated\`. Never page bulk rows through the conversation or claim a complete artifact unless the returned coverage proves it.
6. For row-level previews or exportable raw datasets, always include a deterministic \`ORDER BY\` on stable columns. For order-line exports use \`ORDER BY o.order_date, o.order_number, o.id\` unless the member requested a different stable order. A sample is only reviewable if the full replay returns rows in the same order.
7. If a Menhood query fails with a SQL, schema, or generic tool error, do not loop. Make at most one schema/context probe and one corrected retry for the same request. If it still fails, stop and explain the failure plainly.

## Coverage: this data trails real orders

Orders reach this reporting DB well after they are placed, and they keep arriving for weeks. Measured across two independent settled cohorts:

| Order date cohort | Present by day 7 | by day 14 | by day 30 |
|---|---|---|---|
| 2026-03-01 – 2026-04-15 | 68.2% | 89.9% | 99.1% |
| 2026-05-01 – 2026-06-30 | 60.3% | 78.9% | 95.3% |

Every result carries a \`freshness\` block with \`ordersThrough\` (the latest \`order_date\` that exists at all) and \`maturedThrough\` (on/before this date counts are settled). Read it before describing any number.

1. **Never read an empty result as zero orders.** A window after \`ordersThrough\` is out of range. Say “this data only covers through <date>”, and do not tell the member their sync is broken or their orders stopped — that conclusion is not available from this tool.
2. **Never present a recent window as complete.** Any window overlapping the period after \`maturedThrough\` undercounts. State the shortfall plainly when it is material; do not silently report the partial number.
3. **Current-week, yesterday, today, current-month, and previous-month questions before reporting maturity cannot be answered here as final numbers.** If the member asks for one of these windows, or a result's freshness shows the requested window overlaps the period after \`maturedThrough\`, do not ask whether to check live data and do not present the reporting DB number as the final answer. Load \`airtable-core\` immediately and use the live Airtable Orders table yourself. Carry the member's exact requested window into that filter: a named month or date range becomes explicit start and end bounds in Asia/Kolkata, never a relative window such as \`pastMonth\` or \`thisCalendarMonth\`, which cover a different span and return a different number. Read the count from Airtable's \`metadata.totalRecordCount\` rather than from the preview rows. Ask a follow-up only if Airtable is unavailable or the table/fields cannot be resolved. This tool is for settled, historical analysis: financial years, matured months, cohorts, product and campaign performance.
4. Never compute ROAS, ad spend, or ad-to-sales ratios from this source. Ad spend lives in the live Menhood Management Airtable base; \`menhood_advertisement_costs\` here stopped receiving data on 2025-03-21.
5. When one metric combines two sources, intersect their date ranges or refuse. Never divide N days of orders by M days of ad spend, and never present the result of doing so as a rate.

## Data model and quality

- Exact schema map, verified from the backend Menhood reporting DB:
  - \`menhood_orders\` columns:
    - IDs/joins/dates/status: \`id\`, \`order_number\`, \`order_date\`, \`order_status\`, \`shipping_date\`, \`shipping_partner\`, \`customer_id\`, \`product_id\`, \`sku_id\`, \`shopify_order_id\`, \`createdAt\`, \`updatedAt\`
    - Product/payment/value: \`sku\`, \`payment_method\`, \`payment_type\`, \`quantity\`, \`prebooking_amount\`, \`collectable_value\`, \`declared_value\`, \`shipping_charge\`, \`additional_charge\`, \`additional_discount\`, \`final_amount\`, \`coupon_code\`
    - Attribution: \`utm_source\`, \`utm_medium\`, \`utm_campaign\`, \`utm_content\`, \`click_identifier\`, \`first_touch_utm_url\`, \`last_touch_utm_source\`, \`last_touch_utm_medium\`, \`last_touch_utm_content\`, \`last_touch_utm_url\`
    - Odd legacy column: \`discount _remove\` has a space in the name; avoid it unless explicitly needed, and quote it as \`"discount _remove"\`.
  - \`menhood_customers\` columns: \`id\`, \`customer_name\`, \`email\`, \`phone_number\`, \`alternate_number\`, \`address_line_1\`, \`address_line_2\`, \`city\`, \`state\`, \`pincode\`, \`whatsapp_number\`, \`country\`, \`createdAt\`, \`updatedAt\`.
  - \`menhood_products\` columns: \`id\`, \`product_name\`, \`product_sku\`, \`bundle_sku\`, \`image\`, \`weight\`, \`length\`, \`width\`, \`height\`, \`hsn_code\`, \`createdAt\`, \`updatedAt\`.
  - \`all_cities_with_pincode\` columns: \`id\`, \`pincode\`, \`city\`, \`state\`.
  - PII fields include customer \`email\`, phone/WhatsApp numbers, and address lines. Do not return or group by them unless the member specifically asked for contact/address data.
- \`menhood_orders\` is order-line grain: the observed 160,713 rows represent 134,418 distinct \`order_number\` values. Count \`DISTINCT order_number\` for orders; use raw rows only for line, quantity, or value aggregation.
- This reporting table does **not** contain Airtable view/cleanup fields such as \`Order Status (Team)\`, \`Order Sub Status\`, Duplicate/TEST/Testing labels, or Regular Order filtering. If the member asks for an Airtable-view count, "duplicate/test hata ke", "regular orders", exact live order status team cleanup, or why a live Airtable count differs, switch to \`airtable-core\` and query the live Airtable Orders table yourself; do not ask permission first. Do not approximate these filters with \`order_status\`.
- \`menhood_customers\` is one customer per \`id\`; \`menhood_products\` is one product per \`id\`, not per SKU. \`all_cities_with_pincode\` is lookup-row grain and has 22 observed repeated trimmed pincodes, so aggregate the lookup before joining when one row per pincode is required.
- Join \`menhood_orders.customer_id = menhood_customers.id\` and \`menhood_orders.product_id = menhood_products.id\`. Do not join products by SKU: 62 observed order lines lack \`product_id\`, 5,834 linked lines disagree with \`product_sku\`, and the product table has 11 duplicate normalized-SKU groups.
- Customer display names live in \`menhood_customers.customer_name\`; product display names live in \`menhood_products.product_name\`. There is no generic \`name\` column in either table. Common order fields include \`order_number\`, \`order_date\`, \`order_status\`, \`payment_type\`, \`final_amount\`, \`quantity\`, \`customer_id\`, \`product_id\`, \`utm_source\`, \`utm_medium\`, and \`utm_campaign\`; probe schema first before using any other column.
- Grouped \`order_status\` and \`payment_type\` counts are order-line buckets: the same \`order_number\` can appear in more than one bucket. Do not call them a mutually exclusive distribution or make the percentages imply that the buckets sum to total orders; say “orders with at least one matching line” when that is what was counted.
- For the city lookup, trim the customer and lookup pincodes, remove non-digits, retain only six-digit values, and then join them. Keep pincodes as text so a leading zero is not lost; report excluded invalid values rather than guessing them.
- Treat \`order_status\` values exactly as \`Delivered\`, \`Cancelled\`, and \`RTO Delivered\`; keep null as Unknown. Treat \`payment_type\` exactly as \`COD\` or \`PREPAID\`; keep null as Unknown rather than assigning it to either side.
- Choose \`final_amount\`, \`collectable_value\`, or \`declared_value\` from the member's wording. State the selected meaning when material. Label a \`SUM(final_amount)\` precisely as final-amount/gross order value unless the member defines it as revenue; do not silently call it “revenue” across cancelled or unknown statuses. Ask one short question only when genuinely ambiguous.
- Copy large numeric strings from \`menhoodData\` rows exactly in tables as raw ungrouped digits, with no currency symbol and no commas. For example, show \`107131011\`, not \`1,07,13,1011\` or any hand-formatted INR variant. If readability helps, keep the table value exact and add an approximate crores/lakhs note in prose.
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
