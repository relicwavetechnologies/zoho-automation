/**
 * Zoho Books field registry — static, global, zero runtime cost.
 *
 * Zoho Books field names are defined by Zoho's API and are identical for every
 * company worldwide. Only custom_fields_list entries vary per company, but those
 * are not top-level keys and don't affect standard field access.
 *
 * This replaces the previous runtime-discovery + Redis cache approach.
 * No API calls, no Redis keys, no async — just a lookup.
 */

export interface ZohoBooksModuleSchema {
  readonly module:        string;
  readonly primaryAmount: string;   // use as item._amount
  readonly primaryDate:   string;   // use as item._date
  readonly primaryId:     string;   // use as item._id
  readonly allAmountFields: readonly string[];
  readonly allDateFields:   readonly string[];
  readonly nameFields:      readonly string[];
  readonly statusField:     string | null;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, ZohoBooksModuleSchema> = {
  expenses: {
    module:           'expenses',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'expense_id',
    allAmountFields:  ['total', 'bcy_total', 'total_without_tax'],
    allDateFields:    ['date'],
    nameFields:       ['account_name', 'vendor_name', 'customer_name', 'user_name'],
    statusField:      'status',
  },
  invoices: {
    module:           'invoices',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'invoice_id',
    allAmountFields:  ['total', 'balance', 'bcy_total'],
    allDateFields:    ['date', 'due_date'],
    nameFields:       ['customer_name', 'invoice_number'],
    statusField:      'status',
  },
  bills: {
    module:           'bills',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'bill_id',
    allAmountFields:  ['total', 'balance', 'bcy_total'],
    allDateFields:    ['date', 'due_date'],
    nameFields:       ['vendor_name', 'bill_number'],
    statusField:      'status',
  },
  customerpayments: {
    module:           'customerpayments',
    primaryAmount:    'amount',
    primaryDate:      'date',
    primaryId:        'payment_id',
    allAmountFields:  ['amount', 'bcy_amount'],
    allDateFields:    ['date'],
    nameFields:       ['customer_name', 'payment_number'],
    statusField:      null,
  },
  vendorpayments: {
    module:           'vendorpayments',
    primaryAmount:    'amount',
    primaryDate:      'date',
    primaryId:        'payment_id',
    allAmountFields:  ['amount', 'bcy_amount'],
    allDateFields:    ['date'],
    nameFields:       ['vendor_name', 'payment_number'],
    statusField:      null,
  },
  contacts: {
    module:           'contacts',
    primaryAmount:    'outstanding_receivable_amount',
    primaryDate:      'created_time',
    primaryId:        'contact_id',
    allAmountFields:  ['outstanding_receivable_amount', 'outstanding_payable_amount'],
    allDateFields:    ['created_time'],
    nameFields:       ['contact_name', 'company_name', 'email'],
    statusField:      'status',
  },
  bankaccounts: {
    module:           'bankaccounts',
    primaryAmount:    'balance',
    primaryDate:      'created_time',
    primaryId:        'account_id',
    allAmountFields:  ['balance', 'bcy_balance'],
    allDateFields:    ['created_time'],
    nameFields:       ['account_name', 'account_type'],
    statusField:      null,
  },
  banktransactions: {
    module:           'banktransactions',
    primaryAmount:    'debit_amount',
    primaryDate:      'date',
    primaryId:        'transaction_id',
    allAmountFields:  ['debit_amount', 'credit_amount', 'amount'],
    allDateFields:    ['date'],
    nameFields:       ['payee', 'description', 'reference_number'],
    statusField:      'status',
  },
  items: {
    module:           'items',
    primaryAmount:    'rate',
    primaryDate:      'created_time',
    primaryId:        'item_id',
    allAmountFields:  ['rate', 'purchase_rate'],
    allDateFields:    ['created_time'],
    nameFields:       ['name', 'sku', 'account_name'],
    statusField:      'status',
  },
  creditnotes: {
    module:           'creditnotes',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'creditnote_id',
    allAmountFields:  ['total', 'balance', 'bcy_total'],
    allDateFields:    ['date'],
    nameFields:       ['customer_name', 'creditnote_number'],
    statusField:      'status',
  },
  salesorders: {
    module:           'salesorders',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'salesorder_id',
    allAmountFields:  ['total', 'bcy_total'],
    allDateFields:    ['date', 'shipment_date'],
    nameFields:       ['customer_name', 'salesorder_number'],
    statusField:      'status',
  },
  purchaseorders: {
    module:           'purchaseorders',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'purchaseorder_id',
    allAmountFields:  ['total', 'bcy_total'],
    allDateFields:    ['date', 'delivery_date'],
    nameFields:       ['vendor_name', 'purchaseorder_number'],
    statusField:      'status',
  },
  estimates: {
    module:           'estimates',
    primaryAmount:    'total',
    primaryDate:      'date',
    primaryId:        'estimate_id',
    allAmountFields:  ['total', 'bcy_total'],
    allDateFields:    ['date', 'expiry_date'],
    nameFields:       ['customer_name', 'estimate_number'],
    statusField:      'status',
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the schema for a module, or a safe fallback for unknown modules. */
export function getModuleSchema(module: string): ZohoBooksModuleSchema {
  return REGISTRY[module] ?? {
    module,
    primaryAmount:   'total',
    primaryDate:     'date',
    primaryId:       'id',
    allAmountFields: ['total', 'amount'],
    allDateFields:   ['date'],
    nameFields:      ['name'],
    statusField:     'status',
  };
}

/**
 * Inject _amount, _date, _id onto every record so LLM scripts use
 * consistent names regardless of module.
 */
export function injectSyntheticFields(
  items:  Array<Record<string, unknown>>,
  schema: ZohoBooksModuleSchema,
): Array<Record<string, unknown>> {
  return items.map(item => ({
    ...item,
    _amount: Number(item[schema.primaryAmount] ?? 0),
    _date:   String(item[schema.primaryDate]   ?? ''),
    _id:     String(item[schema.primaryId]     ?? ''),
  }));
}

/**
 * Compact schema hint included in tool results so the LLM knows
 * which fields to use when writing scripts.
 */
export function toSchemaHint(schema: ZohoBooksModuleSchema): Record<string, unknown> {
  return {
    module:        schema.module,
    primaryAmount: `${schema.primaryAmount} → use item._amount`,
    primaryDate:   `${schema.primaryDate} → use item._date`,
    primaryId:     `${schema.primaryId} → use item._id`,
    allAmountFields: schema.allAmountFields,
    allDateFields:   schema.allDateFields,
    nameFields:      schema.nameFields,
    statusField:     schema.statusField,
    note: 'Scripts should use item._amount / item._date / item._id for cross-module consistency.',
  };
}
