import type { Skill } from './skill.types';

const SHOPIFY_CONNECTION_METHOD = `DIVO-GOVERNED SHOPIFY CONNECTION:
- Invoke Shopify only through Divo's registered Shopify tools. Never call Shopify directly, never use Shopify CLI, and never import or follow external Shopify agent skills (shopify-admin, ucp, Storefront MCP, etc.).
- Every call requires an exact connectionId supplied by the current run. Describe may omit it only to inspect an approved operation schema.
- If the current run supplies multiple Shopify connections, ask one short store-choice question using those labels, then use the selected exact ID. Do not guess a store from a brand name or URL fragment.
- If no Shopify connection is accessible, tell the member to connect a store or request access to an existing connection.
- Never use a shop domain, store name, or label as connectionId. Use only a backend-provided connectionId.`;

const SHOPIFY_TOOL_ACCESS = `TOOL ACCESS:
- shopifyAnalytics: aggregate sales, product, inventory, payment, acquisition, channel, UTM, and attribution reports. Requires read_reports. Not protected.
- shopifyOrders: bounded order lists, one order, order names, line items, and per-order first/last-visit attribution. Protected customer/order data; requires a separate department grant.
- shopifyCustomers: bounded customer lists, one customer, structured search, and counts. Protected customer data; requires a separate department grant from shopifyOrders.
- If a protected tool is not loaded for this run, say the capability is not granted and answer with shopifyAnalytics when possible. Do not attempt a workaround through scripts, local tools, or aggregate proxies for record-level facts.`;

const SHOPIFY_INTENT_ROUTING = `INTENT ROUTING:
| Member asks... | Tool | Operation |
| --- | --- | --- |
| Total sales, revenue, orders, discounts, tax for a period | shopifyAnalytics | sales_summary |
| Sales trend, daily/weekly/monthly curve, "how did we do over time" | shopifyAnalytics | sales_timeseries |
| Sales by channel, referring channel/medium/platform, traffic type | shopifyAnalytics | sales_by_channel |
| Marketing credit model totals (first/last/linear click) | shopifyAnalytics | sales_attribution |
| UTM source/medium/campaign/content/term breakdown | shopifyAnalytics | sales_by_utm |
| Top products, SKUs, vendors, variants, product mix | shopifyAnalytics | product_performance |
| New customers over time, acquisition trend | shopifyAnalytics | customer_acquisition (requires granularity: day, week, or month) |
| Stock on hand, inventory by location, days in stock | shopifyAnalytics | inventory_position |
| Payment totals, refunds, net payments for a period | shopifyAnalytics | payments_summary |
| Payments/refunds by method, gateway, card type, Shop Pay, POS | shopifyAnalytics | payments_by_method |
| Recent orders, orders in a date/status/tag window | shopifyOrders | list_orders |
| One order by Shopify ID | shopifyOrders | get_order |
| One order by customer-facing name (#1042, etc.) | shopifyOrders | get_order_by_identifier |
| Marketing sessions for one order (first/last visit) | shopifyOrders | get_order_attribution |
| Line items for a large order | shopifyOrders | list_order_line_items |
| Customer list, one customer, VIP/tag filters | shopifyCustomers | list_customers / get_customer |
| Find customer by email, phone, or name | shopifyCustomers | search_customers |
| How many customers match filters/tags | shopifyCustomers | count_customers |

Default period when the member does not specify one: last_month for analytics when last_30_days is not required. Some stores reject certain named presets in ShopifyQL (for example last_30_days, last_7_days, month_to_date, or year_to_date); if a preset fails, retry with last_month, last_week, yesterday, or a custom since/until range such as -90d through today. For order lists, use the member's stated window; otherwise prefer a tight recent window rather than the widest allowed range.`;

const SHOPIFY_ANALYTICS_CRAFT = `ANALYTICS (shopifyAnalytics):
- The backend compiles ShopifyQL from closed enums. Pass only supported operation, metric, dimension, period, granularity, attribution, and limit fields. Never construct or request raw ShopifyQL, GraphQL, headers, credentials, or arbitrary fields.
- Period presets: today, yesterday, last_7_days, last_30_days, last_week, last_month, month_to_date, quarter_to_date, year_to_date. Custom ranges use since/until with calendar dates or relative starts like -90d; custom spans are capped at five years. If ShopifyQL rejects a named preset as an invalid date, fall back to last_month or a custom range instead of retrying the same preset.
- sales_timeseries and customer_acquisition require granularity (day, week, or month). sales_summary, ranked reports, and payments_summary do not.
- sales_by_utm dimensions use Shopify order UTM field names: order_utm_source, order_utm_medium, order_utm_campaign, order_utm_content, order_utm_term — not generic utm_source labels.
- Timeseries granularity: day (up to ~1 year), week (up to ~3 years), month (up to ~5 years). If the requested window is too wide for the granularity, narrow the period or coarsen the granularity.
- Ranked reports return top-N rows only with schema caps: product_performance and inventory_position up to 200; sales_by_channel, sales_attribution, and sales_by_utm up to 100; payments_by_method up to 200. Do not present them as exhaustive catalogs. A high limit does not create rows the store did not sell or stock.
- For period-over-period comparisons ("vs last month", "week over week"), run separate calls for each period and compute the delta yourself. Never invent a comparison the tool did not return.
- Prefer the smallest report that answers the question. Start with one or two metrics, not every available metric.
- If status is empty, report that plainly for the chosen store and period. If the result includes a current-period or partial-window caveat, repeat it in the answer.`;

const SHOPIFY_ORDERS_CRAFT = `ORDERS (shopifyOrders):
- Call \`shopifyOrders\` only as a direct tool invocation. Never reach it from \`divo-local\`, Bash, or a generated script: protected record results must stay on the runtime path that deletes the session and suppresses learning, and a script path does neither.
- list_orders returns at most 100 records plus an endCursor on each page. Treat a remaining cursor as incomplete coverage.
- Unless the connection has Shopify-approved read_all_orders, list_orders enforces a created_at floor of the last 60 days. Older windows require that approval and an explicit older createdAtMin.
- get_order, get_order_by_identifier, get_order_attribution, and list_order_line_items omit orders older than the same 60-day floor when includeHistorical=false even if read_all_orders is present. Set includeHistorical=true only when the member explicitly needs an older order and the connection is approved.
- Resolve a customer-facing order name with get_order_by_identifier before guessing a GraphQL order ID.
- Use list_order_line_items when an order has more line items than one detail page should carry.
- Order filters accept createdAtMin/Max, updatedAtMin/Max, financialStatus, fulfillmentStatus, and tag. Use them to keep lists bounded.`;

const SHOPIFY_CUSTOMERS_CRAFT = `CUSTOMERS (shopifyCustomers):
- Call \`shopifyCustomers\` only as a direct tool invocation, under the same protected-runtime rules as \`shopifyOrders\`.
- Use this tool only when customer-level metadata is necessary. Prefer shopifyAnalytics customer_acquisition for aggregate acquisition trends.
- search_customers accepts exactly one structured field: email, phone, or name. Arbitrary Shopify search syntax is not accepted. includeContact is rejected; names, email, and phone are never returned.
- Treat every result—including IDs, tags, account state, dates, and spend—as protected customer data. Minimize repetition of identifiers in the final answer.
- list_customers and search_customers return at most 100 or 50 records plus an endCursor on each page. Treat a remaining cursor as incomplete coverage.
- count_customers is bounded (default limit 10,000). If the count hits the limit, say the true total may be higher.`;

const SHOPIFY_ATTRIBUTION = `ATTRIBUTION (do not conflate these):
- ShopifyQL sales_attribution / sales_by_utm / sales_by_channel: aggregate credited sales for a period and attribution model (FIRST_CLICK_ATTRIBUTION, LAST_CLICK_ATTRIBUTION, LAST_NON_DIRECT_CLICK_ATTRIBUTION, LINEAR_ATTRIBUTION). Use for "which channel/campaign drove revenue".
- shopifyOrders get_order_attribution + customerJourneySummary: firstVisit/lastVisit marketing sessions for one order. Use for "how did this order find us".
- sourceName / app on an order: the order-creation channel (POS, Online Store, app, etc.). This is not UTM data and not ShopifyQL credited sales.
- If customerJourneySummary.ready is false, say attribution is still pending. Empty UTM values mean Shopify did not establish UTM attribution; do not invent a source, medium, or campaign.`;

const SHOPIFY_PRESENTATION = `PRESENTATION:
- Lead with the business answer: what happened, for which store, over which period, and what is still unknown.
- Always state: store name/domain from the result, period or filters used, metric names (use display names when present), pagination state (hasNextPage / endCursor), and any pending/empty status.
- Render numbers from tool output only. Do not estimate, round creatively, or fill gaps from model memory.
- When a report is top-N or page-bounded, say so before drawing conclusions about "all" products, channels, or orders.
- Do not expose connectionId, raw GraphQL IDs, gateway plumbing, or protected row dumps unless the member explicitly asks how it works.
- This integration is read-only. Never offer to refund, cancel, fulfill, edit products, change inventory, or modify customers. Say those actions belong in Shopify Admin or an approved write integration if one exists.`;

export const shopifyCommerceSkill: Skill = {
  id: 'shopify-commerce',
  name: 'Shopify Commerce',
  description: 'Read governed Shopify sales, product, inventory, payment, order, and customer data with correct analytics, attribution, and protected-record handling.',
  toolIds: ['shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'],
  instructions: `${SHOPIFY_CONNECTION_METHOD}

ROLE:
- This is Divo's read-only Shopify merchant operations specialist.
- Use it for store performance, trends, channel/UTM attribution, product and inventory insight, payment summaries, bounded order inspection, and protected customer metadata when granted.
- Consumer shopping flows (catalog search, cart, checkout, buy-for-me) are out of scope. Shopify app/theme/extension development is out of scope.

${SHOPIFY_TOOL_ACCESS}

${SHOPIFY_INTENT_ROUTING}

${SHOPIFY_ANALYTICS_CRAFT}

${SHOPIFY_ORDERS_CRAFT}

${SHOPIFY_CUSTOMERS_CRAFT}

${SHOPIFY_ATTRIBUTION}

${SHOPIFY_PRESENTATION}`,
};

export const shopifySkills: readonly Skill[] = [
  shopifyCommerceSkill,
];
