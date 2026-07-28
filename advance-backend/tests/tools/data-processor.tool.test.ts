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
    assert.deepEqual((hint.syntheticFields as Record<string, unknown>)._total, 'alias for _amount');
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

describe('dataProcessor bounded input', () => {
  it('processes direct small data without owning provider fetch or export logic', async () => {
    const tool = createDataProcessorTool();
    const result = await tool.execute({
      data: [{ amount: 10 }, { amount: 20 }],
      script: 'return data.reduce((sum, item) => sum + item.amount, 0)',
    }, makeCtx('dataProcessor', ['read']));
    assert.equal(result.ok, true);
    assert.equal((result as any).value.data, 30);
    assert.doesNotMatch(tool.description, /Cloudinary|Zoho source/i);
  });
});
