import assert from 'node:assert/strict';

import {
  BOOKS_LARGE_RESULT_THRESHOLD,
  BOOKS_MODULE_PROJECTION,
  buildBooksReadRecordsEnvelope,
  projectRecord,
} from '../src/company/orchestration/vercel/runtime-tools';
import { __test__ as orchestrationEngineTest } from '../src/company/orchestration/engine/vercel-orchestration.engine';

const buildInvoice = (index: number): Record<string, unknown> => ({
  invoice_id: `inv_${index}`,
  invoice_number: `INV-${index}`,
  customer_name: `Customer ${index}`,
  total: index * 100,
  balance: index * 25,
  due_date: `2026-04-${String((index % 28) + 1).padStart(2, '0')}`,
  status: index % 2 === 0 ? 'overdue' : 'sent',
  currency_code: 'INR',
  internal_notes: `Note ${index}`,
  nullish_field: null,
});

async function run(): Promise<void> {
  const projectedInvoice = projectRecord(
    {
      invoice_id: 'inv_1',
      invoice_number: 'INV-1',
      customer_name: 'ACME',
      total: 1000,
      balance: 250,
      due_date: '2026-04-01',
      status: 'overdue',
      currency_code: 'INR',
      internal_notes: 'secret',
      email: null,
    },
    'invoices',
  );
  assert.deepEqual(projectedInvoice, {
    invoice_id: 'inv_1',
    invoice_number: 'INV-1',
    customer_name: 'ACME',
    total: 1000,
    balance: 250,
    due_date: '2026-04-01',
    status: 'overdue',
    currency_code: 'INR',
  });

  const unknownRecord = { foo: 'bar', amount: 20 };
  assert.deepEqual(projectRecord(unknownRecord, 'unknown_module'), unknownRecord);

  const largeItems = Array.from(
    { length: BOOKS_LARGE_RESULT_THRESHOLD + 5 },
    (_value, index) => buildInvoice(index + 1),
  );
  const largeEnvelope = buildBooksReadRecordsEnvelope({
    moduleName: 'invoices',
    organizationId: 'org_1',
    resultItems: largeItems,
    raw: { invoices: largeItems },
  });
  const largePayload = largeEnvelope.fullPayload as Record<string, unknown>;
  const largeRecords = (largePayload.records ?? []) as Array<Record<string, unknown>>;
  assert.equal(largeRecords.length, largeItems.length);
  assert.ok(!('raw' in largePayload));
  assert.ok(largeEnvelope.summary.includes('Results projected to essential fields to stay within context limits.'));
  assert.deepEqual(
    Object.keys(largeRecords[0] ?? {}).sort(),
    [...(BOOKS_MODULE_PROJECTION.invoices ?? [])].sort(),
  );

  const smallItems = Array.from({ length: 20 }, (_value, index) => buildInvoice(index + 1));
  const smallEnvelope = buildBooksReadRecordsEnvelope({
    moduleName: 'invoices',
    organizationId: 'org_1',
    resultItems: smallItems,
    raw: { invoices: smallItems },
  });
  const smallPayload = smallEnvelope.fullPayload as Record<string, unknown>;
  const smallRecords = (smallPayload.records ?? []) as Array<Record<string, unknown>>;
  assert.equal(smallRecords.length, smallItems.length);
  assert.ok('raw' in smallPayload);
  assert.ok(!smallEnvelope.summary.includes('Results projected to essential fields'));
  assert.equal(asRecordValue(smallRecords[0], 'internal_notes'), 'Note 1');

  const warmSummary = orchestrationEngineTest.buildWarmSummaryFromStepResults([
    {
      sequence: 1,
      toolName: 'contextSearch',
      actorKey: 'context-agent',
      summary: 'Found candidate match',
      resolvedIds: { customerId: 'candidate_1' },
      authorityLevel: 'candidate',
    },
    {
      sequence: 2,
      toolName: 'zohoBooks',
      actorKey: 'zoho-ops-agent',
      summary: 'Confirmed Books customer',
      resolvedIds: { customerId: 'confirmed_1', organizationId: 'org_9' },
      authorityLevel: 'confirmed',
    },
  ]);
  assert.equal(
    warmSummary.summary,
    'contextSearch(context-agent): Found candidate match. zohoBooks(zoho-ops-agent): Confirmed Books customer',
  );
  assert.deepEqual(warmSummary.resolvedIds, {
    customerId: 'confirmed_1',
    organizationId: 'org_9',
  });

  const mergedResolvedIds = orchestrationEngineTest.mergeWarmResolvedIdsFromStepResults([
    {
      sequence: 1,
      toolName: 'contextSearch',
      resolvedIds: { customerId: 'candidate_customer' },
      authorityLevel: 'candidate',
    },
    {
      sequence: 2,
      toolName: 'contextSearch',
      resolvedIds: { customerId: 'not_found_customer' },
      authorityLevel: 'not_found',
    },
    {
      sequence: 3,
      toolName: 'zohoBooks',
      resolvedIds: { customerId: 'confirmed_customer' },
      authorityLevel: 'confirmed',
    },
  ]);
  assert.equal(mergedResolvedIds.customerId, 'confirmed_customer');

  console.log('p10-harness-ok');
}

const asRecordValue = (
  record: Array<Record<string, unknown>>[number] | undefined,
  key: string,
): unknown => record?.[key];

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
