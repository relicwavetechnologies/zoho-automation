export const DIVO_QUICK_START_METADATA_KEY = 'divoQuickStart'

export type FinanceQuickStartField = {
  id: string
  label: string
  placeholder?: string
  type: 'text' | 'date' | 'number' | 'select'
  required?: boolean
  options?: Array<{ label: string; value: string }>
}

export type FinanceQuickStartDefinition = {
  id: string
  group: string
  title: string
  description: string
  action: string
  access: 'read' | 'write'
  fields: FinanceQuickStartField[]
  buildPrompt: (values: Record<string, string>, accountLabel: string) => string
  buildArgs: (values: Record<string, string>, connectionId: string) => Record<string, unknown>
  skillSlug?: string
}

export type DivoQuickStartPlan = {
  version: 1
  source: 'finance-zoho-quick-start'
  templateId: string
  account: { connectionId: string; label: string }
  safety: 'read_only' | 'approval_required'
  route: {
    op: 'tools.invoke'
    payload: {
      toolId: 'zohoBooks'
      args: Record<string, unknown>
    }
  }
  resolution?: {
    toolId: 'zohoBooks'
    op: 'list_contacts' | 'list_invoices' | 'get_chart_of_accounts' | 'get_account_balance'
    matchField: string
    value: string
    injectAs: string
  }
  skill?: { id: string; slug: string }
}

const dateRange: FinanceQuickStartField[] = [
  { id: 'fromDate', label: 'From', type: 'date' },
  { id: 'toDate', label: 'To', type: 'date' },
]

const optionalCustomer: FinanceQuickStartField = {
  id: 'customer',
  label: 'Customer',
  type: 'text',
  placeholder: 'All customers',
}

const compact = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))

const direct = (
  action: string,
  values: Record<string, string>,
  connectionId: string
) => {
  const normalized = compact(values)
  const args: Record<string, unknown> = { op: action, connectionId }
  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'fromDate') args.dateFrom = value
    else if (key === 'toDate') args.dateTo = value
    else if (key === 'query') args.searchQuery = value
    else if (key === 'minimumBalance') args.minimumBalance = Number(value)
    else if (key === 'status' && value === 'all') continue
    else if (!['customer', 'vendor', 'account', 'invoiceNumber', 'amount', 'dueDate', 'description', 'paymentDate', 'reference'].includes(key)) args[key] = value
  }
  if (
    ['create_invoice', 'record_payment', 'create_bill', 'create_expense'].includes(
      action
    )
  ) {
    args.fields = normalized
  }
  return args
}

export const FINANCE_QUICK_STARTS: FinanceQuickStartDefinition[] = [
  {
    id: 'overdue-receivables',
    group: 'Receivables',
    title: 'Overdue receivables',
    description: 'Age unpaid invoices and surface collection priorities.',
    action: 'build_overdue_report',
    access: 'read',
    fields: [
      optionalCustomer,
      { id: 'asOfDate', label: 'As of', type: 'date', required: true },
      {
        id: 'minimumBalance',
        label: 'Minimum balance',
        type: 'number',
        placeholder: '0',
      },
    ],
    buildPrompt: (v, account) =>
      `Build an overdue customer invoice report from ${account} as of ${v.asOfDate}${v.customer ? ` for ${v.customer}` : ''}${v.minimumBalance ? `, excluding balances below ${v.minimumBalance}` : ''}. Group by aging bucket, total the outstanding amount, and rank the customers that need follow-up first.`,
    buildArgs: (v, connectionId) => {
      if (!v.customer && !v.minimumBalance) {
        return direct('build_overdue_report', v, connectionId)
      }
      return {
        op: 'list_invoices',
        connectionId,
        status: 'overdue',
        dateTo: v.asOfDate,
        scriptArgs: {
          asOfDate: v.asOfDate,
          customer: v.customer || '',
          minimumBalance: Number(v.minimumBalance || 0),
        },
        script:
          "const asOf=new Date(args.asOfDate+'T00:00:00Z'); const customer=String(args.customer||'').toLowerCase(); const minimum=Number(args.minimumBalance||0); return data.filter(i=>{const balance=Number(i._balance_inr||0); const name=String(i.customer_name||'').toLowerCase(); return balance>=minimum && (!customer||name.includes(customer)) && i.due_date && new Date(i.due_date+'T00:00:00Z')<asOf;}).map(i=>{const ageDays=Math.max(0,Math.floor((asOf-new Date(i.due_date+'T00:00:00Z'))/86400000)); return {invoiceId:i.invoice_id,invoiceNumber:i.invoice_number,customer:i.customer_name,dueDate:i.due_date,ageDays,agingBucket:ageDays<=30?'1-30':ageDays<=60?'31-60':ageDays<=90?'61-90':'90+',balanceInr:i._balance_inr,currency:i._currency,status:i.status};}).sort((a,b)=>b.ageDays-a.ageDays||b.balanceInr-a.balanceInr)",
      }
    },
  },
  {
    id: 'invoice-search',
    group: 'Invoice desk',
    title: 'Find an invoice',
    description: 'Locate an invoice by number or customer and show its status.',
    action: 'search_transactions',
    access: 'read',
    fields: [
      { id: 'query', label: 'Invoice number or customer', type: 'text', required: true },
    ],
    buildPrompt: (v, account) =>
      `Find the invoice matching “${v.query}” in ${account}. Return the exact invoice, customer, issue and due dates, total, balance, payment status, and any ambiguity instead of guessing.`,
    buildArgs: (v, connectionId) =>
      direct('search_transactions', { query: v.query, transactionType: 'invoice' }, connectionId),
  },
  {
    id: 'invoice-register',
    group: 'Invoice desk',
    title: 'Invoice register',
    description: 'Review invoices for a period, customer, or status.',
    action: 'list_invoices',
    access: 'read',
    fields: [
      ...dateRange,
      optionalCustomer,
      {
        id: 'status',
        label: 'Status',
        type: 'select',
        options: [
          { label: 'All statuses', value: 'all' },
          { label: 'Unpaid', value: 'unpaid' },
          { label: 'Overdue', value: 'overdue' },
          { label: 'Paid', value: 'paid' },
          { label: 'Draft', value: 'draft' },
        ],
      },
    ],
    buildPrompt: (v, account) =>
      `Show the invoice register from ${account}${v.fromDate || v.toDate ? ` for ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}${v.customer ? ` for ${v.customer}` : ''}${v.status && v.status !== 'all' ? ` with ${v.status} status` : ''}. Include invoice number, customer, dates, total, balance, and status, followed by useful totals.`,
    buildArgs: (v, connectionId) => direct('list_invoices', v, connectionId),
  },
  {
    id: 'create-invoice',
    group: 'Invoice desk',
    title: 'Create an invoice',
    description: 'Prepare a customer invoice with a deliberate approval step.',
    action: 'create_invoice',
    access: 'write',
    fields: [
      { id: 'customer', label: 'Customer', type: 'text', required: true },
      { id: 'amount', label: 'Amount', type: 'number', required: true },
      { id: 'dueDate', label: 'Due date', type: 'date', required: true },
      { id: 'description', label: 'Line item / description', type: 'text', required: true },
    ],
    buildPrompt: (v, account) =>
      `Prepare an invoice in ${account} for ${v.customer}, amount ${v.amount}, due ${v.dueDate}, for “${v.description}”. Resolve the customer record, show me the exact invoice draft and any missing tax or line-item detail, and request approval before creating it.`,
    buildArgs: (v, connectionId) => direct('create_invoice', v, connectionId),
  },
  {
    id: 'send-invoice',
    group: 'Receivables',
    title: 'Send an invoice',
    description: 'Resolve the invoice and request approval before sending.',
    action: 'send_invoice',
    access: 'write',
    fields: [{ id: 'invoiceNumber', label: 'Invoice number', type: 'text', required: true }],
    buildPrompt: (v, account) =>
      `Find invoice ${v.invoiceNumber} in ${account}, verify the customer, balance, recipient and current status, then request approval to send it. Do not send a different or ambiguous match.`,
    buildArgs: (v, connectionId) => direct('send_invoice', v, connectionId),
  },
  {
    id: 'record-payment',
    group: 'Payments',
    title: 'Record a customer payment',
    description: 'Match a receipt to an invoice and request approval.',
    action: 'record_payment',
    access: 'write',
    fields: [
      { id: 'invoiceNumber', label: 'Invoice number', type: 'text', required: true },
      { id: 'amount', label: 'Amount received', type: 'number', required: true },
      { id: 'paymentDate', label: 'Payment date', type: 'date', required: true },
      { id: 'reference', label: 'Reference', type: 'text', placeholder: 'Bank / UTR reference' },
    ],
    buildPrompt: (v, account) =>
      `In ${account}, match payment ${v.amount} received on ${v.paymentDate} to invoice ${v.invoiceNumber}${v.reference ? ` with reference ${v.reference}` : ''}. Verify the invoice and remaining balance, then request approval before recording the payment.`,
    buildArgs: (v, connectionId) => direct('record_payment', v, connectionId),
  },
  {
    id: 'payment-register',
    group: 'Payments',
    title: 'Customer payments',
    description: 'Review receipts for a period and reconcile customer activity.',
    action: 'list_payments',
    access: 'read',
    fields: [...dateRange, optionalCustomer],
    buildPrompt: (v, account) =>
      `Review customer payments in ${account}${v.fromDate || v.toDate ? ` from ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}${v.customer ? ` for ${v.customer}` : ''}. Show payment number, customer, date, amount, currency, status, and totals for the period.`,
    buildArgs: (v, connectionId) => direct('list_payments', v, connectionId),
  },
  {
    id: 'vendor-bills',
    group: 'Bills & AP',
    title: 'Vendor bills',
    description: 'Review bills due, or prepare a new bill from vendor details.',
    action: 'list_bills',
    access: 'read',
    fields: [
      ...dateRange,
      { id: 'vendor', label: 'Vendor', type: 'text', placeholder: 'All vendors' },
      { id: 'status', label: 'Status', type: 'select', options: [
        { label: 'Open and overdue', value: 'open' },
        { label: 'All bills', value: 'all' },
        { label: 'Paid', value: 'paid' },
      ] },
    ],
    buildPrompt: (v, account) =>
      `Review vendor bills in ${account}${v.vendor ? ` for ${v.vendor}` : ''}${v.fromDate || v.toDate ? ` from ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}. Show due dates, status, amount due, and the payments that should be prioritized.`,
    buildArgs: (v, connectionId) => direct('list_bills', v, connectionId),
  },
  {
    id: 'create-vendor-bill',
    group: 'Bills & AP',
    title: 'Create a vendor bill',
    description: 'Prepare a bill with an exact vendor match and approval.',
    action: 'create_bill',
    access: 'write',
    skillSlug: 'zoho-books-bill',
    fields: [
      { id: 'vendor', label: 'Vendor', type: 'text', required: true },
      { id: 'billNumber', label: 'Bill number', type: 'text', required: true },
      { id: 'amount', label: 'Amount', type: 'number', required: true },
      { id: 'billDate', label: 'Bill date', type: 'date', required: true },
      { id: 'dueDate', label: 'Due date', type: 'date', required: true },
      { id: 'description', label: 'Expense / description', type: 'text', required: true },
    ],
    buildPrompt: (v, account) =>
      `Prepare vendor bill ${v.billNumber} in ${account} for ${v.vendor}, amount ${v.amount}, dated ${v.billDate}, due ${v.dueDate}, for “${v.description}”. Check for a duplicate and resolve the exact vendor, then show the bill draft and request approval before creating it.`,
    buildArgs: (v, connectionId) => direct('create_bill', v, connectionId),
  },
  {
    id: 'expense-register',
    group: 'Expenses',
    title: 'Expense review',
    description: 'Inspect spend by period, account, vendor, or category.',
    action: 'list_expenses',
    access: 'read',
    fields: [...dateRange, { id: 'query', label: 'Vendor or category', type: 'text', placeholder: 'All expenses' }],
    buildPrompt: (v, account) =>
      `Review expenses in ${account}${v.fromDate || v.toDate ? ` from ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}${v.query ? ` matching ${v.query}` : ''}. Summarize total spend and highlight unusual, duplicated, or high-value entries without inventing classifications.`,
    buildArgs: (v, connectionId) => direct('list_expenses', v, connectionId),
  },
  {
    id: 'record-expense',
    group: 'Expenses',
    title: 'Record an expense',
    description: 'Prepare a categorized expense with approval.',
    action: 'create_expense',
    access: 'write',
    fields: [
      { id: 'vendor', label: 'Vendor / payee', type: 'text', required: true },
      { id: 'account', label: 'Expense account', type: 'text', required: true },
      { id: 'amount', label: 'Amount', type: 'number', required: true },
      { id: 'expenseDate', label: 'Expense date', type: 'date', required: true },
      { id: 'description', label: 'Description', type: 'text', required: true },
    ],
    buildPrompt: (v, account) =>
      `Prepare an expense in ${account} for ${v.vendor}, amount ${v.amount}, dated ${v.expenseDate}, categorized to ${v.account}, with description “${v.description}”. Resolve the exact account, show the proposed record, and request approval before creating it.`,
    buildArgs: (v, connectionId) => direct('create_expense', v, connectionId),
  },
  {
    id: 'bank-activity',
    group: 'Cash & bank',
    title: 'Bank activity',
    description: 'Review cash movements and unreconciled transactions.',
    action: 'list_bank_transactions',
    access: 'read',
    fields: [...dateRange, { id: 'account', label: 'Bank / cash account', type: 'text', placeholder: 'All accounts' }],
    buildPrompt: (v, account) =>
      `Review bank transactions in ${account}${v.account ? ` for ${v.account}` : ''}${v.fromDate || v.toDate ? ` from ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}. Separate inflows and outflows, total them, and flag unreconciled or suspicious entries.`,
    buildArgs: (v, connectionId) => direct('list_bank_transactions', v, connectionId),
  },
  {
    id: 'account-balance',
    group: 'Tax & accounts',
    title: 'Account balance',
    description: 'Get a verified balance for a ledger account as of a date.',
    action: 'get_account_balance',
    access: 'read',
    fields: [
      { id: 'account', label: 'Ledger account', type: 'text', required: true },
      { id: 'asOfDate', label: 'As of', type: 'date', required: true },
    ],
    buildPrompt: (v, account) =>
      `Get the verified balance of ${v.account} in ${account} as of ${v.asOfDate}. Resolve the exact chart-of-accounts entry and report the account name, type, balance, currency, and source date.`,
    buildArgs: (v, connectionId) => direct('get_account_balance', v, connectionId),
  },
  {
    id: 'tax-summary',
    group: 'Tax & accounts',
    title: 'Tax summary',
    description: 'Summarize output and input tax for a reporting period.',
    action: 'get_tax_summary',
    access: 'read',
    fields: dateRange.map((field) => ({ ...field, required: true })),
    buildPrompt: (v, account) =>
      `Get the tax summary from ${account} for ${v.fromDate} through ${v.toDate}. Show output tax, input tax, net payable or credit, and the underlying period and currency. Flag incomplete data rather than estimating it.`,
    buildArgs: (v, connectionId) => direct('get_tax_summary', v, connectionId),
  },
  {
    id: 'transaction-search',
    group: 'Finance analysis',
    title: 'Search transactions',
    description: 'Trace a reference, amount, customer, or vendor across Books.',
    action: 'search_transactions',
    access: 'read',
    fields: [
      { id: 'query', label: 'Search term', type: 'text', required: true },
      ...dateRange,
    ],
    buildPrompt: (v, account) =>
      `Search ${account} for transactions matching “${v.query}”${v.fromDate || v.toDate ? ` from ${v.fromDate || 'the beginning'} through ${v.toDate || 'today'}` : ''}. Return exact matches grouped by transaction type with dates, parties, amounts, statuses, and stable record identifiers.`,
    buildArgs: (v, connectionId) => direct('search_transactions', v, connectionId),
  },
]

export function compileFinanceQuickStart(
  definition: FinanceQuickStartDefinition,
  values: Record<string, string>,
  account: { connectionId: string; label: string },
  skillId?: string
): { prompt: string; plan: DivoQuickStartPlan } {
  const resolution = (() => {
    if (definition.id === 'create-invoice') {
      return { toolId: 'zohoBooks' as const, op: 'list_contacts' as const, matchField: 'customer name', value: values.customer, injectAs: 'fields.customer_id' }
    }
    if (definition.id === 'create-vendor-bill') {
      return { toolId: 'zohoBooks' as const, op: 'list_contacts' as const, matchField: 'vendor name', value: values.vendor, injectAs: 'fields.vendor_id' }
    }
    if (definition.id === 'record-expense') {
      return { toolId: 'zohoBooks' as const, op: 'get_chart_of_accounts' as const, matchField: 'account_name', value: values.account, injectAs: 'fields.account_id' }
    }
    if (definition.id === 'send-invoice' || definition.id === 'record-payment') {
      return { toolId: 'zohoBooks' as const, op: 'list_invoices' as const, matchField: 'invoice_number', value: values.invoiceNumber, injectAs: definition.id === 'send-invoice' ? 'invoiceId' : 'fields.invoice_id' }
    }
    if (definition.id === 'account-balance') {
      return { toolId: 'zohoBooks' as const, op: 'get_account_balance' as const, matchField: 'account_name', value: values.account, injectAs: 'accountId' }
    }
    return undefined
  })()
  return {
    prompt: definition.buildPrompt(values, account.label),
    plan: {
      version: 1,
      source: 'finance-zoho-quick-start',
      templateId: definition.id,
      account,
      safety: definition.access === 'write' ? 'approval_required' : 'read_only',
      route: {
        op: 'tools.invoke',
        payload: {
          toolId: 'zohoBooks',
          args: definition.buildArgs(values, account.connectionId),
        },
      },
      ...(resolution ? { resolution } : {}),
      ...(definition.skillSlug && skillId
        ? { skill: { id: skillId, slug: definition.skillSlug } }
        : {}),
    },
  }
}

export function readDivoQuickStartPlan(metadata: unknown): DivoQuickStartPlan | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = (metadata as Record<string, unknown>)[DIVO_QUICK_START_METADATA_KEY]
  if (!value || typeof value !== 'object') return null
  const plan = value as Partial<DivoQuickStartPlan>
  if (
    plan.version !== 1 ||
    plan.source !== 'finance-zoho-quick-start' ||
    typeof plan.templateId !== 'string' ||
    !plan.account?.connectionId ||
    plan.route?.op !== 'tools.invoke' ||
    plan.route.payload?.toolId !== 'zohoBooks'
  ) return null
  return plan as DivoQuickStartPlan
}

export function buildDivoQuickStartContext(plan: DivoQuickStartPlan | null): string {
  if (!plan) return ''
  const route = JSON.stringify(plan.route)
  return [
    '[DIVO_FINANCE_QUICK_START]',
    'This is a desktop-compiled Finance quick start for the current user turn.',
    `Selected Zoho connection: ${plan.account.label} (${plan.account.connectionId}).`,
    'Do not call Divo Memory Recall, divo_skill_resolve, skills.search, connections.list, or substitute another connection.',
    ...(plan.skill
      ? [
          `First fetch the specialist recipe with exactly: ${JSON.stringify({ op: 'skills.get', payload: { skillId: plan.skill.id } })}. Follow that recipe without resolver discovery.`,
        ]
      : ['Do not fetch a routing or general finance skill; the route is already resolved.']),
    ...(plan.resolution
      ? [
          `First resolve exactly one record with: ${JSON.stringify({ op: 'tools.invoke', payload: { toolId: plan.resolution.toolId, args: { op: plan.resolution.op, connectionId: plan.account.connectionId, ...(['get_account_balance', 'get_chart_of_accounts'].includes(plan.resolution.op) ? {} : { searchQuery: plan.resolution.value }) } } })}`,
          `Match ${plan.resolution.matchField} to "${plan.resolution.value}". Reject zero or multiple plausible matches. Inject the stable ID as ${plan.resolution.injectAs} into the requested operation.`,
          `Then execute the requested gateway operation: ${route}`,
        ]
      : [`Exact first gateway request: ${route}`]),
    plan.safety === 'approval_required'
      ? 'This is a write action. Preserve backend HITL: show the exact resolved record/change and wait for approval whenever the gateway returns pending approval.'
      : 'This is read-only. Execute the exact route immediately and present the structured result.',
    'Do not invent IDs or substitute a different account. Do not re-route the request.',
    'Treat the user-visible request as the reporting/output contract. Backend permissions and approval remain authoritative.',
    '[/DIVO_FINANCE_QUICK_START]',
  ].join('\n')
}
