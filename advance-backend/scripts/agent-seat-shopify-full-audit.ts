import 'dotenv/config';
import { loadAndValidateEnv } from '../src/config/env';
import { AgentSeatService } from '../src/application/agent-seat/agent-seat.service';
import {
  buildAgentSeatContainer,
  shutdownAgentSeatContainer,
} from '../src/application/agent-seat/agent-seat-container';
import { loadAgentSeatSession } from '../src/application/agent-seat/agent-seat-session';
import { LarkToolMessagingClient } from '../src/infrastructure/channels/lark/clients/lark-messaging.client';
import type { GatewayResponse } from '../src/application/gateway/gateway.types';

const FULL_PERIOD = { kind: 'range' as const, since: '-5y' as const, until: 'today' as const };
const YTD_PERIOD = { kind: 'range' as const, since: '2025-01-01' as const, until: 'today' as const };
const LAST_YEAR = { kind: 'range' as const, since: '2024-01-01' as const, until: '2024-12-31' as const };

type Step = {
  readonly label: string;
  readonly toolId: 'shopifyAnalytics' | 'shopifyOrders' | 'shopifyCustomers';
  readonly args: Record<string, unknown>;
};

function extractResult(response: GatewayResponse): unknown {
  if (!response.ok) return { error: response.error?.message ?? response.status };
  return (response.data as { result?: unknown })?.result ?? response.data;
}

function rowCount(result: unknown): number | undefined {
  const data = (result as { data?: { rows?: unknown[] } })?.data;
  return Array.isArray(data?.rows) ? data.rows.length : undefined;
}

function firstRow(result: unknown): Record<string, string> | undefined {
  const rows = (result as { data?: { rows?: Array<Record<string, string>> } })?.data?.rows;
  return rows?.[0];
}

const INVOKE_TIMEOUT_MS = 60_000;

function logStep(message: string): void {
  console.error(`[shopify-audit] ${message}`);
}

async function withTimeout<T>(label: string, promise: Promise<T>, ms = INVOKE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function splitForLark(markdown: string, maxChars = 3_500): string[] {
  if (markdown.length <= maxChars) return [markdown];
  const sections = markdown.split(/\n(?=### )/);
  const chunks: string[] = [];
  let current = '';
  for (const section of sections) {
    if ((current + section).length > maxChars && current) {
      chunks.push(current.trim());
      current = section;
    } else {
      current += (current ? '\n' : '') + section;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [markdown.slice(0, maxChars)];
}

async function main(): Promise<void> {
  const env = loadAndValidateEnv(process.env);
  const session = await loadAgentSeatSession();
  const container = await buildAgentSeatContainer(env);
  const service = new AgentSeatService({
    prisma: container.prisma,
    channelIdentityRepo: container.channelIdentityRepo,
    gatewayDispatcher: container.gatewayDispatcher,
  });

  const connections = await service.gateway(session, {
    op: 'connections.list',
    payload: { provider: 'shopify' },
  });
  const connectionId = ((connections.response.data as { connections?: Array<{ connectionId: string }> })
    ?.connections ?? [])[0]?.connectionId;
  if (!connectionId) throw new Error('No accessible Shopify connection. Run seed:shopify-agent-seat first.');

  const steps: Step[] = [
    {
      label: 'Lifetime summary (5y max window)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_summary',
        metrics: ['total_sales', 'net_sales', 'orders', 'discounts', 'taxes'],
        period: FULL_PERIOD,
      },
    },
    {
      label: 'Monthly trend (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_timeseries',
        metrics: ['total_sales', 'orders'],
        granularity: 'month',
        period: FULL_PERIOD,
      },
    },
    {
      label: 'Sales by channel (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_by_channel',
        metrics: ['total_sales', 'orders'],
        dimension: 'sales_channel',
        period: FULL_PERIOD,
        limit: 100,
      },
    },
    {
      label: 'UTM source/medium/campaign (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_by_utm',
        metrics: ['total_sales', 'orders'],
        dimensions: ['order_utm_source', 'order_utm_medium', 'order_utm_campaign'],
        period: FULL_PERIOD,
        limit: 50,
      },
    },
    {
      label: 'Last-click channel attribution (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_attribution',
        metric: 'total_sales',
        dimension: 'referring_channel',
        attribution: 'LAST_CLICK_ATTRIBUTION',
        period: FULL_PERIOD,
        limit: 25,
      },
    },
    {
      label: 'Top 50 products (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'product_performance',
        metrics: ['net_sales', 'orders', 'net_items_sold'],
        dimensions: ['product_title', 'product_variant_sku'],
        period: FULL_PERIOD,
        limit: 50,
      },
    },
    {
      label: 'Customer acquisition monthly (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'customer_acquisition',
        metrics: ['new_customer_records', 'percent_of_customers'],
        granularity: 'month',
        period: FULL_PERIOD,
      },
    },
    {
      label: 'Payments summary (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'payments_summary',
        metrics: ['gross_payments', 'refunded_payments', 'net_payments', 'transactions'],
        period: FULL_PERIOD,
      },
    },
    {
      label: 'Payments by method (5y)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'payments_by_method',
        metrics: ['net_payments', 'transactions'],
        dimensions: ['payment_method', 'payment_gateway'],
        period: FULL_PERIOD,
        limit: 50,
      },
    },
    {
      label: 'Inventory snapshot (30d window)',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'inventory_position',
        metrics: ['ending_inventory_units_at_location', 'days_in_stock_at_location'],
        dimensions: ['inventory_location_name', 'product_title'],
        period: { kind: 'range', since: '-30d', until: 'today' },
        limit: 100,
      },
    },
    {
      label: 'YTD 2025 sales',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_summary',
        metrics: ['total_sales', 'orders'],
        period: YTD_PERIOD,
      },
    },
    {
      label: 'Full calendar 2024 sales',
      toolId: 'shopifyAnalytics',
      args: {
        connectionId,
        operation: 'sales_summary',
        metrics: ['total_sales', 'orders'],
        period: LAST_YEAR,
      },
    },
    {
      label: 'Total customer count',
      toolId: 'shopifyCustomers',
      args: { connectionId, operation: 'count_customers', limit: 10_000 },
    },
    {
      label: 'Paid orders (60d API window)',
      toolId: 'shopifyOrders',
      args: {
        connectionId,
        operation: 'list_orders',
        first: 100,
        filters: { financialStatus: 'paid' },
      },
    },
  ];

  const findings: Array<{
    label: string;
    ok: boolean;
    detail: string;
    raw?: unknown;
  }> = [];

  for (const step of steps) {
    const started = Date.now();
    logStep(`START ${step.label} (${step.toolId})`);
    let response: GatewayResponse;
    try {
      ({ response } = await withTimeout(
        step.label,
        service.invoke(session, step.toolId, step.args),
      ));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push({ label: step.label, ok: false, detail });
      logStep(`FAIL ${step.label} (${Date.now() - started}ms): ${detail}`);
      continue;
    }
    const result = extractResult(response);
    if (!response.ok) {
      findings.push({ label: step.label, ok: false, detail: String((result as { error?: string }).error ?? response.status) });
      logStep(`FAIL ${step.label} (${Date.now() - started}ms): ${findings.at(-1)?.detail}`);
      continue;
    }
    logStep(`OK ${step.label} (${Date.now() - started}ms)`);

    if (step.toolId === 'shopifyCustomers' && (result as { operation?: string }).operation === 'count_customers') {
      const count = (result as { data?: { count?: number } }).data?.count;
      findings.push({ label: step.label, ok: true, detail: `${count ?? 'unknown'} customers`, raw: result });
      continue;
    }

    if (step.toolId === 'shopifyOrders') {
      const orders = (result as { data?: Array<{ name?: string; id?: string; totalPriceSet?: { shopMoney?: { amount?: string } } }> }).data ?? [];
      const hasNext = (result as { pageInfo?: { hasNextPage?: boolean } }).pageInfo?.hasNextPage ?? false;
      findings.push({
        label: step.label,
        ok: true,
        detail: `${orders.length} paid order(s) returned${hasNext ? ' (more pages exist)' : ''}`,
        raw: result,
      });
      continue;
    }

    const summary = firstRow(result);
    const rows = rowCount(result);
    if (summary) {
      findings.push({
        label: step.label,
        ok: true,
        detail: Object.entries(summary).map(([k, v]) => `${k}=${v ?? 'null'}`).join(', '),
        raw: result,
      });
    } else {
      findings.push({
        label: step.label,
        ok: true,
        detail: rows !== undefined ? `${rows} row(s)` : 'complete',
        raw: result,
      });
    }
  }

  // Attribution on first paid order if available
  const ordersStep = findings.find(f => f.label.startsWith('Paid orders'));
  const firstOrder = ((ordersStep?.raw as { data?: Array<{ id?: string; name?: string }> })?.data ?? [])[0];
  if (firstOrder?.id) {
    logStep(`START Order attribution (${firstOrder.name ?? firstOrder.id})`);
    try {
      const { response } = await withTimeout(
        'Order attribution',
        service.invoke(session, 'shopifyOrders', {
          connectionId,
          operation: 'get_order_attribution',
          orderId: firstOrder.id,
          includeHistorical: false,
        }),
      );
      const result = extractResult(response);
      findings.push({
        label: `Order attribution (${firstOrder.name ?? firstOrder.id})`,
        ok: response.ok,
        detail: response.ok ? 'attribution fetched' : String((result as { error?: string }).error ?? response.status),
        raw: result,
      });
      logStep(response.ok ? 'OK Order attribution' : `FAIL Order attribution: ${findings.at(-1)?.detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push({ label: `Order attribution (${firstOrder.name ?? firstOrder.id})`, ok: false, detail });
      logStep(`FAIL Order attribution: ${detail}`);
    }
  }

  const report = buildReport(findings, connectionId);
  const stepSummary = findings.map(f => ({ label: f.label, ok: f.ok, detail: f.detail }));
  console.log(JSON.stringify({ stepSummary, report }, null, 2));

  const appId = process.env['LARK_APP_ID'];
  const appSecret = process.env['LARK_APP_SECRET'];
  const messageIds: string[] = [];
  if (appId && appSecret && session.chatId) {
    const client = new LarkToolMessagingClient({ appId, appSecret });
    const parts = splitForLark(report);
    for (const [index, part] of parts.entries()) {
      const body = parts.length > 1 ? `${part}\n\n_(Part ${index + 1}/${parts.length})_` : part;
      const sent = await client.sendMessage(session.chatId, body);
      messageIds.push(sent.messageId);
      logStep(`Delivered Lark part ${index + 1}/${parts.length}: ${sent.messageId}`);
    }
    console.log(JSON.stringify({ deliveredToLark: true, chatId: session.chatId, messageIds, partCount: parts.length }, null, 2));
  } else {
    console.log(JSON.stringify({ deliveredToLark: false, reason: 'Missing LARK creds or session chatId' }, null, 2));
  }

  await Promise.race([
    shutdownAgentSeatContainer(),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  process.exit(0);
}

function buildReport(
  findings: Array<{ label: string; ok: boolean; detail: string; raw?: unknown }>,
  connectionId: string,
): string {
  const store = (findings.find(f => f.label.includes('Lifetime'))?.raw as { store?: { name?: string; domain?: string } })?.store;
  const lifetime = findings.find(f => f.label.includes('Lifetime'));
  const ytd = findings.find(f => f.label.includes('YTD 2025'));
  const y2024 = findings.find(f => f.label.includes('2024'));
  const topProducts = ((findings.find(f => f.label.includes('Top 50'))?.raw as { data?: { rows?: Array<Record<string, string>> } })?.data?.rows ?? []).slice(0, 10);
  const channels = ((findings.find(f => f.label.includes('channel (5y)'))?.raw as { data?: { rows?: Array<Record<string, string>> } })?.data?.rows ?? []).slice(0, 8);
  const utm = ((findings.find(f => f.label.includes('UTM'))?.raw as { data?: { rows?: Array<Record<string, string>> } })?.data?.rows ?? []).slice(0, 8);
  const monthly = ((findings.find(f => f.label.includes('Monthly trend'))?.raw as { data?: { rows?: Array<Record<string, string>> } })?.data?.rows ?? []);
  const orders = ((findings.find(f => f.label.startsWith('Paid orders'))?.raw as { data?: Array<{ name?: string; createdAt?: string; displayFinancialStatus?: string; totalPriceSet?: { shopMoney?: { amount?: string } } }> })?.data ?? []);
  const customers = findings.find(f => f.label.includes('customer count'));
  const failed = findings.filter(f => !f.ok);

  const lines = [
    '## Shopify full-store audit (max reportable window)',
    '',
    `**Store:** ${store?.name ?? 'Shopify store'} (${store?.domain ?? 'unknown'})`,
    '',
    '**Complex prompt tested:** full-history business review — not limited to 30 days. Analytics use the **5-year ShopifyQL cap**; orders use the **60-day read_orders window** (no read_all_orders on this connection).',
    '',
    '### Lifetime totals (5-year report window)',
    lifetime?.ok ? `- ${lifetime.detail}` : `- Failed: ${lifetime?.detail ?? 'n/a'}`,
    '',
    '### Year comparison',
    ytd?.ok ? `- **2025 YTD:** ${ytd.detail}` : `- 2025 YTD failed: ${ytd?.detail ?? 'n/a'}`,
    y2024?.ok ? `- **Calendar 2024:** ${y2024.detail}` : `- 2024 failed: ${y2024?.detail ?? 'n/a'}`,
    '',
    '### Monthly trend (sample — last 6 months in window)',
    ...monthly.slice(-6).map(row => `- ${Object.entries(row).map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ')}`),
    ...(monthly.length === 0 ? ['- No monthly rows returned'] : []),
    '',
    '### Top products (5y, top 10 of 50)',
    ...topProducts.map((row, i) => `${i + 1}. ${row.product_title ?? 'Unknown'} — net_sales ${row.net_sales ?? '0'} · orders ${row.orders ?? '0'}`),
    ...(topProducts.length === 0 ? ['- No product rows'] : []),
    '',
    '### Channel mix (5y)',
    ...channels.map(row => `- ${row.sales_channel ?? 'unknown'}: total_sales ${row.total_sales ?? '0'} · orders ${row.orders ?? '0'}`),
    ...(channels.length === 0 ? ['- No channel rows'] : []),
    '',
    '### UTM mix (5y, top rows)',
    ...utm.map(row => `- source=${row.order_utm_source ?? '(none)'} / medium=${row.order_utm_medium ?? '(none)'} / campaign=${row.order_utm_campaign ?? '(none)'} → sales ${row.total_sales ?? '0'}`),
    ...(utm.length === 0 ? ['- No UTM rows'] : []),
    '',
    '### Customers',
    customers?.ok ? `- **Total count:** ${customers.detail}` : `- Count failed: ${customers?.detail ?? 'n/a'}`,
    '',
    '### Paid orders (accessible window)',
    ...orders.map(o => `- **${o.name ?? '?'}** · ${o.displayFinancialStatus ?? 'unknown'} · ${o.totalPriceSet?.shopMoney?.amount ?? '?'} · ${o.createdAt ?? 'unknown date'}`),
    ...(orders.length === 0 ? ['- No paid orders in accessible window'] : []),
    '',
  ];

  if (failed.length > 0) {
    lines.push('### Failed steps', ...failed.map(f => `- ${f.label}: ${f.detail}`), '');
  }

  lines.push(
    '---',
    `_14 governed tool calls · connection ${connectionId.slice(0, 8)}… · Agent Seat full-audit runner_`,
  );

  return lines.join('\n');
}

main().catch(async error => {
  console.error(error);
  await shutdownAgentSeatContainer().catch(() => undefined);
  process.exit(1);
});
