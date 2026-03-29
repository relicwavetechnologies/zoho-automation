import test from 'node:test';
import assert from 'node:assert/strict';

import { __vercelMutationGuardTestUtils } from '../src/company/orchestration/engine/vercel-orchestration.engine';

test('evaluateRunCompletion marks a confirmed action as completed', () => {
  const completion = __vercelMutationGuardTestUtils.evaluateRunCompletion([
    {
      toolId: 'google-gmail',
      toolName: 'googleMail',
      success: true,
      status: 'success',
      data: { id: 'msg-1' },
      confirmedAction: true,
      summary: 'Sent Gmail message.',
    },
  ]);

  assert.deepEqual(completion, {
    status: 'completed',
    confirmedCount: 1,
    failedCount: 0,
  });
});

test('evaluateRunCompletion marks failed attempts without confirmed actions', () => {
  const completion = __vercelMutationGuardTestUtils.evaluateRunCompletion([
    {
      toolId: 'zoho-books-write',
      toolName: 'booksWrite',
      success: false,
      status: 'error',
      data: null,
      confirmedAction: false,
      error: 'Zoho Books update failed.',
      summary: 'Zoho Books update failed.',
    },
  ]);

  assert.deepEqual(completion, {
    status: 'attempted_failed',
    confirmedCount: 0,
    failedCount: 1,
    errors: ['Zoho Books update failed.'],
  });
});

test('evaluateRunCompletion ignores read-only success results', () => {
  const completion = __vercelMutationGuardTestUtils.evaluateRunCompletion([
    {
      toolId: 'zoho-books-read',
      toolName: 'booksRead',
      success: true,
      status: 'success',
      data: { invoices: [] },
      confirmedAction: false,
      summary: 'Found 0 invoices.',
    },
  ]);

  assert.deepEqual(completion, {
    status: 'no_action_attempted',
    confirmedCount: 0,
    failedCount: 0,
  });
});
