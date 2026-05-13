import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './tool-test.helpers.ts';
import { createDataProcessorTool } from '../../src/application/orchestration/tools/families/data-processor.tool.ts';
import { getModuleSchema, injectSyntheticFields, toSchemaHint } from '../../src/infrastructure/zoho/zoho-books-schema.cache.ts';

describe('Zoho Books schema synthetic fields', () => {
  it('maps bill totals and balances to distinct synthetic fields', () => {
    const schema = getModuleSchema('bills');
    const [bill] = injectSyntheticFields([
      {
        bill_id: 'bill-1',
        total: 7670,
        balance: 1170,
        date: '2026-04-15',
        vendor_name: 'Acme',
      },
    ], schema);

    assert.equal(bill._amount, 7670);
    assert.equal(bill._total, 7670);
    assert.equal(bill._balance, 1170);
    assert.equal(bill._date, '2026-04-15');
    assert.equal(bill._id, 'bill-1');

    const hint = toSchemaHint(schema, bill);
    assert.equal(hint.balanceField, 'balance -> item._balance (unpaid/outstanding)');
    assert.deepEqual((hint.syntheticFields as Record<string, unknown>)._total, 'full document amount (alias for _amount)');
    assert.ok((hint.sampleFieldNames as string[]).includes('vendor_name'));
  });

  it('falls back to _amount for modules without a balance field', () => {
    const schema = getModuleSchema('expenses');
    const [expense] = injectSyntheticFields([
      {
        expense_id: 'exp-1',
        total: 250,
        date: '2026-04-20',
      },
    ], schema);

    assert.equal(expense._amount, 250);
    assert.equal(expense._total, 250);
    assert.equal(expense._balance, 250);
  });
});

describe('dataProcessor Zoho source accuracy hints', () => {
  it('exposes _balance, sample fields, full-unit formatAmount, and truncation warning', async () => {
    const tool = createDataProcessorTool({
      cloudinary: { isAvailable: false, uploadCsvBuffer: async () => null } as any,
      booksClient: {
        listAllRecords: async () => ({
          organizationId: 'org-1',
          items: [
            {
              bill_id: 'bill-1',
              bill_number: 'BILL-1',
              vendor_name: 'Acme',
              total: 7670,
              balance: 1170,
              currency_code: 'INR',
              date: '2026-04-15',
              due_date: '2026-04-30',
            },
          ],
          truncated: true,
        }),
      } as any,
    });

    const result = await tool.execute({
      zohoSource: { module: 'bills' },
      script: [
        'const outstanding = data.reduce((sum, bill) => sum + bill._balance, 0);',
        'return {',
        '  outstanding,',
        '  total: data[0]._total,',
        '  formattedTotal: formatAmount(data[0]._total, data[0].currency_code),',
        '  sampleFields: schema.sampleFieldNames,',
        '};',
      ].join('\n'),
    }, makeCtx('dataProcessor', ['read']));

    assert.equal(result.ok, true);
    const value = (result as any).value;
    assert.equal(value.data.outstanding, 1170);
    assert.equal(value.data.total, 7670);
    assert.equal(value.data.formattedTotal, '₹7,670.00');
    assert.equal(value.sourceTruncated, true);
    assert.match(value.message, /DATA INCOMPLETE/);
    assert.equal(value.moduleSchema.balanceField, 'balance -> item._balance (unpaid/outstanding)');
    assert.ok(value.data.sampleFields.includes('vendor_name'));
    assert.ok(value.moduleSchema.sampleFieldNames.includes('due_date'));
  });
});
