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
  readonly balanceField:  string | null; // use as item._balance when available
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
    balanceField:     null,
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
    balanceField:     'balance',
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
    balanceField:     'balance',
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     'balance',
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:     null,
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
    balanceField:    null,
    primaryDate:     'date',
    primaryId:       'id',
    allAmountFields: ['total', 'amount'],
    allDateFields:   ['date'],
    nameFields:      ['name'],
    statusField:     'status',
  };
}

/**
 * Inject synthetic fields onto every record so LLM scripts use
 * consistent names regardless of module.
 */
export interface CurrencyConverter {
  readonly toINR: (amount: number, currency: string) => number;
}

/**
 * Inject synthetic fields onto every record.
 *
 * When a `converter` is provided, also injects pre-converted INR fields
 * (`_amount_inr`, `_balance_inr`, `_total_inr`) so LLM scripts never need
 * to call toINR() themselves — the conversion is done deterministically here.
 *
 * Conversion priority for each amount:
 *   1. If Zoho provides a `bcy_*` field (base currency) → use it directly
 *   2. If the record has `exchange_rate` → multiply amount × exchange_rate
 *   3. If `_currency === 'INR'` → amount is already INR
 *   4. Fallback → use live rate via converter.toINR()
 */
export function injectSyntheticFields(
  items:     Array<Record<string, unknown>>,
  schema:    ZohoBooksModuleSchema,
  converter?: CurrencyConverter,
): Array<Record<string, unknown>> {
  return items.map(item => {
    const raw = item['currency_code'] ?? item['currency'] ?? '';
    const currency = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : 'INR';

    const amount  = Number(item[schema.primaryAmount] ?? 0);
    const balance = schema.balanceField
      ? Number(item[schema.balanceField] ?? 0)
      : amount;

    const result: Record<string, unknown> = {
      ...item,
      _amount:   amount,
      _total:    amount,
      _balance:  balance,
      _date:     String(item[schema.primaryDate] ?? ''),
      _id:       String(item[schema.primaryId]   ?? ''),
      _currency: currency,
    };

    if (converter) {
      result._amount_inr  = toBaseINR(item, amount, currency, schema.primaryAmount, converter);
      result._total_inr   = result._amount_inr;
      result._balance_inr = schema.balanceField
        ? toBaseINR(item, balance, currency, schema.balanceField, converter)
        : result._amount_inr;
    }

    return result;
  });
}

/**
 * Convert an amount to INR using the best available source:
 *   1. bcy_ field from Zoho (exact, recorded at transaction time)
 *   2. exchange_rate field × amount (Zoho's own rate)
 *   3. Already INR → no conversion
 *   4. Live rate via converter
 */
function toBaseINR(
  item:       Record<string, unknown>,
  amount:     number,
  currency:   string,
  fieldName:  string,
  converter:  CurrencyConverter,
): number {
  if (amount === 0) return 0;

  const bcyKey = `bcy_${fieldName}`;
  const bcyVal = Number(item[bcyKey] ?? 0);
  if (bcyVal > 0) return Math.round(bcyVal * 100) / 100;

  if (currency === 'INR') return amount;

  const exchangeRate = Number(item['exchange_rate'] ?? 0);
  if (exchangeRate > 0) return Math.round(amount * exchangeRate * 100) / 100;

  return converter.toINR(amount, currency);
}

/**
 * Compact schema hint included in tool results so the LLM knows
 * which fields to use when writing scripts.
 */
export function toSchemaHint(
  schema: ZohoBooksModuleSchema,
  sampleRecord?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    module:        schema.module,
    primaryAmount: `${schema.primaryAmount} -> item._amount / item._total`,
    primaryDate:   `${schema.primaryDate} -> item._date`,
    primaryId:     `${schema.primaryId} -> item._id`,
    balanceField:  schema.balanceField
      ? `${schema.balanceField} -> item._balance (unpaid/outstanding)`
      : 'none - _balance equals _amount for this module',
    allAmountFields: schema.allAmountFields,
    allDateFields:   schema.allDateFields,
    nameFields:      schema.nameFields,
    statusField:     schema.statusField,
    syntheticFields: {
      _amount:      'full document amount in original currency',
      _total:       'alias for _amount',
      _balance:     schema.balanceField
        ? 'unpaid/outstanding portion in original currency'
        : 'equals _amount (no separate balance for this module)',
      _amount_inr:  'full document amount PRE-CONVERTED to INR — use this for all INR totals/sums',
      _total_inr:   'alias for _amount_inr',
      _balance_inr: schema.balanceField
        ? 'unpaid/outstanding portion PRE-CONVERTED to INR — use this for overdue/outstanding INR totals'
        : 'equals _amount_inr',
      _date:        'primary date field',
      _id:          'primary record ID',
      _currency:    'ISO currency code of this record (e.g. "INR", "USD")',
    },
    ...(sampleRecord ? { sampleFieldNames: Object.keys(sampleRecord).slice(0, 20) } : {}),
    currencyUtilities: {
      note:          'PREFER using _amount_inr / _balance_inr / _total_inr for INR sums — they are pre-converted and guaranteed correct.',
      toINR:         'toINR(amount, item._currency) — manual convert to INR. Only needed if computing a custom field not pre-converted.',
      fromINR:       'fromINR(amount, targetCode) — convert INR to target currency (e.g. for "show in USD")',
      convert:       'convert(amount, from, to) — convert between any two currencies',
      exchangeRates: 'exchangeRates.USD, exchangeRates.AED etc — INR per 1 unit of foreign currency',
      formatAmount:  'formatAmount(value, "INR") — ₹ with Indian grouping; formatAmount(value, "USD") — $ with US grouping',
    },
    note: 'IMPORTANT: Use _amount_inr/_balance_inr/_total_inr for all INR calculations — they are pre-converted using Zoho\'s own exchange rate recorded at transaction time. For overdue/outstanding queries, use _balance_inr. For "show in USD" use fromINR(_balance_inr, "USD"). NEVER manually call toINR() on _amount/_balance — use the _inr variants instead.',
  };
}
