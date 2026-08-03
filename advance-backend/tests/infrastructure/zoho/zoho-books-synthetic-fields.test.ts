import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getModuleSchema,
  injectSyntheticFields,
  toSchemaHint,
} from '../../../src/infrastructure/zoho/zoho-books-schema.cache';

/** Real shape of a Zoho Books bank transaction list row, field names verified live. */
const BANK_TRANSACTION = {
  transaction_id: '3846597000009587295',
  date: '2026-06-30',
  amount: 7113.85,
  status: 'uncategorized',
  account_id: '3846597000009355454',
  currency_code: 'INR',
  debit_or_credit: 'debit',
  running_balance: 1200,
};

/** Real shape of a Zoho Books bank account list row: no date field of any kind. */
const BANK_ACCOUNT = {
  account_id: '3846597000009608224',
  account_name: 'Aleem sir Petty Cash',
  currency_code: 'INR',
  balance: 96400,
  bcy_balance: 96400,
};

const converter = { toINR: (amount: number) => amount };

describe('zoho books synthetic fields', () => {
  it('carries the real bank transaction amount instead of a confident zero', () => {
    const [row] = injectSyntheticFields(
      [BANK_TRANSACTION],
      getModuleSchema('banktransactions'),
      converter,
    );

    // The registry used to name `debit_amount`, which Zoho never sends. That
    // made every amount `Number(undefined ?? 0)` — a wrong number reported as
    // fact, including through the _inr fields the tool tells scripts to prefer.
    assert.equal(row?.['_amount'], 7113.85);
    assert.equal(row?.['_total'], 7113.85);
    assert.equal(row?.['_balance'], 7113.85);
    assert.equal(row?.['_amount_inr'], 7113.85);
    assert.equal(row?.['_total_inr'], 7113.85);
    assert.equal(row?.['_balance_inr'], 7113.85);
    assert.equal(row?.['_date'], '2026-06-30');
    assert.equal(row?.['_id'], '3846597000009587295');
    assert.equal(row?.['_status'], 'uncategorized');
  });

  it('falls through to a declared amount field when the preferred one is absent', () => {
    const schema = {
      ...getModuleSchema('banktransactions'),
      primaryAmount: 'debit_amount',
      allAmountFields: ['debit_amount', 'amount'] as const,
    };

    const [row] = injectSyntheticFields([BANK_TRANSACTION], schema, converter);

    assert.equal(row?.['_amount'], 7113.85);
  });

  it('does not invent a date for a module that carries none', () => {
    const schema = getModuleSchema('bankaccounts');
    assert.equal(schema.primaryDate, null);

    const [row] = injectSyntheticFields([BANK_ACCOUNT], schema, converter);

    assert.equal(row?.['_date'], '');
    assert.equal(row?.['_amount'], 96400);

    const hint = toSchemaHint(schema);
    assert.match(String(hint['primaryDate']), /carries no date/);
  });

  it('treats an explicit null the same as an absent field', () => {
    const schema = {
      ...getModuleSchema('banktransactions'),
      primaryAmount: 'debit_amount',
      allAmountFields: ['debit_amount', 'amount'] as const,
    };

    const [row] = injectSyntheticFields(
      [{ ...BANK_TRANSACTION, debit_amount: null }],
      schema,
      converter,
    );

    assert.equal(row?.['_amount'], 7113.85);
  });
});
