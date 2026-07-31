/**
 * Manual Zoho Books verification scratchpad.
 *
 * This file is intentionally edited for each question under test. It gathers
 * raw Zoho evidence and the production-agent answer; a human reviewer decides
 * correctness from those two artifacts.
 *
 * Current question:
 *   Verify a complete date-bounded expense aggregation and vendor ranking.
 *
 * Usage:
 *   pnpm tsx scripts/zoho-query-test-suite.ts --account Emiac
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import { DEFAULT_MODEL } from '../src/application/observability/pricing';
import { resolveHarnessOpenId } from './run-engine-harness';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asDepartmentId,
  asMessageId,
  asUserId,
} from '../src/shared/ids';
import { asCompanyRoleSlug } from '../src/domain/permissions/company-role';
import type { IncomingMessage } from '../src/domain/channel/incoming-message';
import type { RunContext } from '../src/domain/orchestration/run-context';
import type { ConversationHandle } from '../src/application/channels/channel.adapter';

const SHIVAM_SELECTOR = 'Shivam Bhateja';
const DELIVERY_CHAT_ID = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const REPORT_PATH = 'zoho-test-report.json';

interface RawInvoice extends Record<string, unknown> {
  readonly invoice_id?: string;
  readonly invoice_number?: string;
  readonly customer_name?: string;
  readonly status?: string;
  readonly currency_code?: string;
  readonly date?: string;
  readonly due_date?: string;
  readonly total?: number | string;
  readonly bcy_total?: number | string;
  readonly balance?: number | string;
  readonly bcy_balance?: number | string;
  readonly exchange_rate?: number | string;
  readonly line_items?: unknown[];
}

interface RawPayment extends Record<string, unknown> {
  readonly payment_id?: string;
  readonly currency_code?: string;
  readonly amount?: number | string;
  readonly bcy_amount?: number | string;
  readonly exchange_rate?: number | string;
}

interface RawExpense extends Record<string, unknown> {
  readonly expense_id?: string;
  readonly vendor_name?: string;
  readonly currency_code?: string;
  readonly total?: number | string;
  readonly bcy_total?: number | string;
  readonly exchange_rate?: number | string;
}

interface Invocation {
  readonly outerTool: string;
  readonly toolId?: string;
  readonly args?: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asRecords = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.flatMap(item => asRecord(item) ?? []) : [];

const asNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalized = (value: unknown): string => String(value ?? '').trim().toLowerCase();

function parseAccount(args: readonly string[]): string {
  if (args.length === 0) return 'Emiac';
  if (args.length === 2 && args[0] === '--account' && args[1]?.trim()) return args[1].trim();
  throw new Error('Usage: pnpm tsx scripts/zoho-query-test-suite.ts --account <label>');
}

function invoiceId(invoice: RawInvoice): string {
  return String(invoice.invoice_id ?? '');
}

function baseBalance(invoice: RawInvoice): number {
  if (invoice.bcy_balance !== undefined) return asNumber(invoice.bcy_balance);
  return asNumber(invoice.balance) * (asNumber(invoice.exchange_rate) || 1);
}

function baseTotal(invoice: RawInvoice): number {
  if (invoice.bcy_total !== undefined) return asNumber(invoice.bcy_total);
  return asNumber(invoice.total) * (asNumber(invoice.exchange_rate) || 1);
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function installZohoWriteBlock(): () => void {
  const originalFetch = global.fetch;
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0]);
    const method = (args[1]?.method ?? 'GET').toUpperCase();
    if (url.includes('/books/v3') && method !== 'GET') {
      throw new Error(`READ_ONLY_VERIFIER_BLOCKED_ZOHO_${method}`);
    }
    return originalFetch(...args);
  }) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

async function zohoGet(
  auth: { accessToken: string; apiBaseUrl: string },
  path: string,
  params: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${auth.apiBaseUrl.replace(/\/$/, '')}/books/v3${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${auth.accessToken}` },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || (typeof body['code'] === 'number' && body['code'] !== 0)) {
    throw new Error(
      `Zoho GET ${path} failed (${response.status}): ${String(body['message'] ?? 'unknown error')}`,
    );
  }
  return body;
}

async function fetchEveryInvoice(
  auth: { accessToken: string; apiBaseUrl: string },
  organizationId: string,
): Promise<{ invoices: RawInvoice[]; pages: number }> {
  const invoices = new Map<string, RawInvoice>();
  for (let page = 1; page <= 500; page++) {
    const body = await zohoGet(auth, '/invoices', {
      organization_id: organizationId,
      page,
      per_page: 200,
    });
    for (const raw of asRecords(body['invoices'])) {
      const invoice = raw as RawInvoice;
      const id = invoiceId(invoice);
      if (id) invoices.set(id, invoice);
    }
    const pageContext = asRecord(body['page_context']);
    if (pageContext?.['has_more_page'] !== true) {
      return { invoices: [...invoices.values()], pages: page };
    }
  }
  throw new Error('Raw Zoho invoice pagination exceeded 500 pages; refusing to use incomplete evidence');
}

async function fetchEveryPayment(
  auth: { accessToken: string; apiBaseUrl: string },
  organizationId: string,
): Promise<{ payments: RawPayment[]; pages: number }> {
  const payments = new Map<string, RawPayment>();
  for (let page = 1; page <= 500; page++) {
    const body = await zohoGet(auth, '/customerpayments', {
      organization_id: organizationId,
      page,
      per_page: 200,
    });
    for (const raw of asRecords(body['customerpayments'])) {
      const payment = raw as RawPayment;
      const id = String(payment.payment_id ?? '');
      if (id) payments.set(id, payment);
    }
    const pageContext = asRecord(body['page_context']);
    if (pageContext?.['has_more_page'] !== true) {
      return { payments: [...payments.values()], pages: page };
    }
  }
  throw new Error('Raw Zoho payment pagination exceeded 500 pages; refusing to use incomplete evidence');
}

function basePaymentAmount(payment: RawPayment): number {
  if (payment.bcy_amount !== undefined) return asNumber(payment.bcy_amount);
  return asNumber(payment.amount) * (asNumber(payment.exchange_rate) || 1);
}

async function fetchEveryExpense(
  auth: { accessToken: string; apiBaseUrl: string },
  organizationId: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ expenses: RawExpense[]; pages: number }> {
  const expenses = new Map<string, RawExpense>();
  for (let page = 1; page <= 500; page++) {
    const body = await zohoGet(auth, '/expenses', {
      organization_id: organizationId,
      date_start: dateFrom,
      date_end: dateTo,
      page,
      per_page: 200,
    });
    for (const raw of asRecords(body['expenses'])) {
      const expense = raw as RawExpense;
      const id = String(expense.expense_id ?? '');
      if (id) expenses.set(id, expense);
    }
    const pageContext = asRecord(body['page_context']);
    if (pageContext?.['has_more_page'] !== true) {
      return { expenses: [...expenses.values()], pages: page };
    }
  }
  throw new Error('Raw Zoho expense pagination exceeded 500 pages; refusing to use incomplete evidence');
}

function baseExpenseTotal(expense: RawExpense): number {
  if (expense.bcy_total !== undefined) return asNumber(expense.bcy_total);
  return asNumber(expense.total) * (asNumber(expense.exchange_rate) || 1);
}

function buildInvoiceDrillEvidence(invoice: RawInvoice) {
  const lineItems = asRecords(invoice.line_items);
  const firstLine = lineItems[0];
  return {
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number,
    customerName: invoice.customer_name,
    status: invoice.status,
    invoiceDate: invoice.date,
    dueDate: invoice.due_date,
    currency: invoice.currency_code,
    exchangeRate: asNumber(invoice.exchange_rate),
    total: asNumber(invoice.total),
    totalInBaseCurrency: baseTotal(invoice),
    balance: asNumber(invoice.balance),
    balanceInBaseCurrency: baseBalance(invoice),
    lineItemCount: lineItems.length,
    firstLineItem: firstLine
      ? {
          name: firstLine['name'],
          description: firstLine['description'],
          quantity: asNumber(firstLine['quantity']),
          rate: asNumber(firstLine['rate']),
          itemTotal: asNumber(firstLine['item_total']),
        }
      : null,
  };
}

async function loadInvocations(
  prisma: Awaited<ReturnType<typeof buildContainer>>['prisma'],
  requestId: string,
): Promise<Invocation[]> {
  const run = await prisma.executionRun.findUnique({
    where: { requestId },
    select: {
      events: {
        where: { eventType: 'tool_call_started' },
        orderBy: { sequence: 'asc' },
        select: { actorKey: true, payload: true },
      },
    },
  });
  return (run?.events ?? []).map(event => {
    const payload = asRecord(event.payload);
    const outerTool = typeof payload?.['toolName'] === 'string'
      ? payload['toolName']
      : event.actorKey ?? '';
    const outerArgs = asRecord(payload?.['args']);
    const toolId = typeof outerArgs?.['toolId'] === 'string'
      ? outerArgs['toolId']
      : undefined;
    const args = asRecord(outerArgs?.['args']);
    return {
      outerTool,
      ...(toolId ? { toolId } : {}),
      ...(args ? { args } : {}),
    };
  });
}

function redactInvocations(invocations: readonly Invocation[]): Invocation[] {
  return invocations.map(invocation => ({
    ...invocation,
    ...(invocation.args
      ? {
        args: {
          ...invocation.args,
          ...(typeof invocation.args['connectionId'] === 'string'
            ? { connectionId: `…${invocation.args['connectionId'].slice(-6)}` }
            : {}),
        },
      }
      : {}),
  }));
}

async function main(): Promise<void> {
  const requestedAccount = parseAccount(process.argv.slice(2));
  const env = loadAndValidateEnv({ ...process.env, MEM0_ENABLED: 'false' });
  const container = await buildContainer(env);
  const restoreFetch = installZohoWriteBlock();

  try {
    const userOpenId = await resolveHarnessOpenId(container.prisma, SHIVAM_SELECTOR);
    const identityResult = await container.channelIdentityRepo.resolveByLarkOpenId(userOpenId);
    if (!identityResult.ok || !identityResult.value) {
      throw new Error(`No DB-linked identity found for ${SHIVAM_SELECTOR}`);
    }
    const identity = identityResult.value;
    console.log(
      `Principal: ${identity.displayName ?? identity.email ?? SHIVAM_SELECTOR}; `
      + `role=${identity.aiRole}; activeDepartment=${identity.activeDepartmentId ?? '∅'}`,
    );

    const accessible = await container.integrationConnectionRepo.listAccessibleZohoConnections({
      companyId: identity.companyId,
      userId: identity.userId,
    });
    if (!accessible.ok) throw accessible.error;
    const needle = normalized(requestedAccount);
    const matches = accessible.value.filter(connection =>
      [connection.label, connection.accountName, connection.accountEmail]
        .some(value => normalized(value).includes(needle)),
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No accessible Zoho account matched "${requestedAccount}". Available: `
            + accessible.value.map(connection => connection.label).join(', ')
          : `Zoho account "${requestedAccount}" is ambiguous: `
            + matches.map(connection => connection.label).join(', '),
      );
    }
    const connection = matches[0]!;
    const auth = await container.zohoTokenService.getValidConnectionAuth({
      companyId: identity.companyId,
      userId: identity.userId,
      connectionId: connection.connectionId,
      minimumAccess: 'read_only',
    });
    const organizationBody = await zohoGet(auth, '/organizations', {});
    const organizations = asRecords(organizationBody['organizations']);
    const organization = organizations.find(item =>
      item['is_default_org'] === true || item['is_default'] === true,
    ) ?? organizations[0];
    const organizationId = String(organization?.['organization_id'] ?? '');
    if (!organizationId) throw new Error(`Zoho account ${connection.label} returned no organization`);
    const organizationName = String(
      organization?.['name'] ?? connection.accountName ?? connection.label,
    );
    const baseCurrency = String(organization?.['currency_code'] ?? 'INR');

    const dateFrom = '2026-07-01';
    const dateTo = '2026-07-29';
    const raw = await fetchEveryExpense(auth, organizationId, dateFrom, dateTo);
    const byVendor = new Map<string, { count: number; totalInr: number }>();
    for (const expense of raw.expenses) {
      const vendor = String(expense.vendor_name ?? '').trim() || '(No vendor)';
      const current = byVendor.get(vendor) ?? { count: 0, totalInr: 0 };
      current.count += 1;
      current.totalInr += baseExpenseTotal(expense);
      byVendor.set(vendor, current);
    }
    const evidence = {
      dateFrom,
      dateTo,
      totalRecords: raw.expenses.length,
      totalAmountInr: raw.expenses.reduce(
        (sum, expense) => sum + baseExpenseTotal(expense),
        0,
      ),
      topVendors: [...byVendor.entries()]
        .map(([vendor, values]) => ({ vendor, ...values }))
        .sort((left, right) =>
          right.totalInr - left.totalInr || left.vendor.localeCompare(right.vendor))
        .slice(0, 5),
    };
    console.log('\n=== DIRECT ZOHO EVIDENCE ===');
    console.log(`Account: ${connection.label}`);
    console.log(`Organization: ${organizationName}`);
    console.log(`Pages fetched: ${raw.pages}`);
    console.log('Expected expense facts:', JSON.stringify(evidence, null, 2));

    const prompt =
      `Using only the "${connection.label}" Zoho Books account, scan every expense dated `
      + `${dateFrom} through ${dateTo} inclusive. Report the exact expense-record count and exact `
      + `grand total in ${baseCurrency}, then rank the top five vendors by summed ${baseCurrency} `
      + 'expense total with each vendor\'s record count and total. Treat a blank vendor as '
      + '"(No vendor)". Do not answer from a preview or incomplete page. '
      + 'This is strictly read-only. '
      + 'Do not create, update, delete, export, schedule, message, email, or save anything.';
    const now = new Date();
    const requestId = `om_zoho_verify_${randomUUID()}`;
    const traceId = asCorrelationId(`${requestId}-${now.getTime()}`);
    const incoming: IncomingMessage = {
      channel: 'lark',
      messageId: asMessageId(requestId),
      chatId: asChatId(`zoho_verify_fresh_${requestId}`),
      chatType: 'p2p',
      userExternalId: userOpenId,
      text: prompt,
      attachments: [],
      timestamp: now.toISOString(),
      traceId,
      mentions: [],
      mentionsSelf: true,
      raw: {},
    };
    const runContext: RunContext = {
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'lark',
      traceId: String(traceId),
      requestId,
      userExternalId: userOpenId,
      chatId: DELIVERY_CHAT_ID,
      ...(identity.activeDepartmentId
        ? { departmentId: asDepartmentId(identity.activeDepartmentId) }
        : {}),
    };
    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: asChatId(DELIVERY_CHAT_ID),
      correlationId: traceId,
    };

    console.log('\n=== FLASH AGENT RUN ===');
    console.log(`Prompt: ${prompt}`);
    const startedAt = Date.now();
    const result = await container.engine.run({
      incoming,
      runContext,
      conversation,
      channelAdapter: container.larkAdapter,
      approvalGate: container.approvalGate,
      larkModelId: DEFAULT_MODEL,
    });
    const durationMs = Date.now() - startedAt;
    if (!result.ok) throw result.error;
    const reply = result.value.finalReply.text.replace(/<!--TOOL_TRACE:.*?-->/gs, '').trim();
    const invocations = await loadInvocations(container.prisma, requestId);

    console.log(`Duration: ${durationMs}ms`);
    console.log('\n=== COMPLETE AGENT REPLY ===');
    console.log(reply);
    console.log('\n=== TOOL INVOCATIONS ===');
    console.log(JSON.stringify(redactInvocations(invocations), null, 2));
    console.log('\n=== MANUAL COMPARISON REQUIRED ===');
    console.log(
      `Expected ${evidence.totalRecords} expenses and `
      + `${formatAmount(evidence.totalAmountInr, baseCurrency)} base total.`,
    );
    console.log('Compare the complete reply above against the direct evidence and trace.');

    writeFileSync(REPORT_PATH, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      reviewer: 'Codex manual review required',
      principal: SHIVAM_SELECTOR,
      model: DEFAULT_MODEL,
      account: connection.label,
      organization: organizationName,
      organizationId: `…${organizationId.slice(-6)}`,
      pagesFetched: raw.pages,
      evidence,
      prompt,
      agentReply: reply,
      durationMs,
      requestId,
      invocations: redactInvocations(invocations),
    }, null, 2)}\n`, 'utf8');
    console.log(`Evidence report: ${REPORT_PATH}`);
  } finally {
    restoreFetch();
    await container.prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('CRASH:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
