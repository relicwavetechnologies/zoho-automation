import assert from 'node:assert/strict';

import { stepResultRepository } from '../src/company/observability';
import { __test__ as vercelDesktopEngineTest } from '../src/modules/desktop-chat/vercel-desktop.engine';
import { prisma } from '../src/utils/prisma';

type StepResultRecord = {
  id: string;
  executionId: string;
  sequence: number;
  toolName: string;
  actorKey: string | null;
  title: string | null;
  success: boolean;
  status: string | null;
  authorityLevel: string | null;
  resolvedIds: Record<string, unknown> | null;
  entityIndexes: Record<string, unknown> | null;
  summary: string | null;
  rawOutput: Record<string, unknown> | null;
  createdAt: Date;
};

const rows: StepResultRecord[] = [];
let idCounter = 1;

const originalStepResult = (prisma as any).stepResult;

(prisma as any).stepResult = {
  create: async ({ data }: any) => {
    const row: StepResultRecord = {
      id: `step_result_${idCounter++}`,
      executionId: data.executionId,
      sequence: data.sequence,
      toolName: data.toolName,
      actorKey: data.actorKey ?? null,
      title: data.title ?? null,
      success: data.success,
      status: data.status ?? null,
      authorityLevel: data.authorityLevel ?? null,
      resolvedIds: (data.resolvedIds as Record<string, unknown> | null) ?? null,
      entityIndexes: (data.entityIndexes as Record<string, unknown> | null) ?? null,
      summary: data.summary ?? null,
      rawOutput: (data.rawOutput as Record<string, unknown> | null) ?? null,
      createdAt: new Date(),
    };
    rows.push(row);
    return row;
  },
  findMany: async ({ where }: any) =>
    rows
      .filter((row) => row.executionId === where.executionId)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime()),
};

async function run(): Promise<void> {
  const persisted = await stepResultRepository.writeStepResult({
    executionId: 'exec_repo',
    sequence: 2,
    toolName: 'contextSearch',
    actorKey: 'contextSearch',
    title: 'Context search',
    success: true,
    status: 'done',
    authorityLevel: 'authoritative',
    resolvedIds: { customerId: '123' },
    entityIndexes: { customer: [{ id: '123' }] },
    summary: 'Found customer',
    rawOutput: { ok: true },
  });
  const repoRows = await stepResultRepository.listStepResults('exec_repo');
  assert.equal(persisted.toolName, 'contextSearch');
  assert.equal(repoRows.length, 1);
  assert.equal(repoRows[0].summary, 'Found customer');
  assert.deepEqual(repoRows[0].resolvedIds, { customerId: '123' });

  await vercelDesktopEngineTest.writeStepResultSafe({
    executionId: 'exec_finish_success',
    sequence: 3,
    toolName: 'zohoBooks',
    actorKey: 'zohoBooks',
    title: 'Zoho lookup',
    status: 'done',
    output: {
      toolId: 'zohoBooks',
      status: 'success',
      data: null,
      confirmedAction: false,
      success: true,
      summary: 'Fetched customer statement',
      authorityLevel: 'authoritative',
      resolvedIds: { customerId: '1500391000028880041' },
      entityIndexes: { customer: [{ id: '1500391000028880041' }] },
    } as any,
  });
  const successRow = rows.find((row) => row.executionId === 'exec_finish_success');
  assert.ok(successRow);
  assert.equal(successRow?.success, true);
  assert.equal(successRow?.summary, 'Fetched customer statement');
  assert.deepEqual(successRow?.resolvedIds, { customerId: '1500391000028880041' });

  await vercelDesktopEngineTest.writeStepResultSafe({
    executionId: 'exec_finish_failed',
    sequence: 4,
    toolName: 'contextSearch',
    actorKey: 'contextSearch',
    title: 'Context search failed',
    status: 'failed',
    output: {
      toolId: 'contextSearch',
      status: 'error',
      data: null,
      confirmedAction: false,
      success: false,
      summary: 'No matching records found',
    } as any,
  });
  const failedRow = rows.find((row) => row.executionId === 'exec_finish_failed');
  assert.ok(failedRow);
  assert.equal(failedRow?.success, false);
  assert.equal(failedRow?.status, 'failed');

  await stepResultRepository.writeStepResult({
    executionId: 'exec_order',
    sequence: 9,
    toolName: 'toolB',
    success: true,
    rawOutput: { b: true },
  });
  await stepResultRepository.writeStepResult({
    executionId: 'exec_order',
    sequence: 5,
    toolName: 'toolA',
    success: true,
    rawOutput: { a: true },
  });
  const ordered = await stepResultRepository.listStepResults('exec_order');
  assert.deepEqual(ordered.map((row) => row.sequence), [5, 9]);

  console.log('step-result-harness-ok');
}

run()
  .finally(() => {
    (prisma as any).stepResult = originalStepResult;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
