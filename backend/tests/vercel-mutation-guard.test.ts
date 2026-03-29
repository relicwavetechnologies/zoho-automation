import test from 'node:test';
import assert from 'node:assert/strict';

import { __vercelMutationGuardTestUtils } from '../src/company/orchestration/engine/vercel-orchestration.engine';
import type { VercelToolEnvelope } from '../src/company/orchestration/vercel/types';

test('googleMail send results count as confirmed mutations', () => {
  const output: VercelToolEnvelope = {
    success: true,
    summary: 'Sent Gmail message "Audit Documentation: Invoice List".',
  };

  assert.equal(__vercelMutationGuardTestUtils.isMutationToolResult('googleMail', output), true);
});

test('googleMail read results do not count as confirmed mutations', () => {
  const output: VercelToolEnvelope = {
    success: true,
    summary: 'Found 10 message(s).',
    keyData: {
      operation: 'listMessages',
    },
  };

  assert.equal(__vercelMutationGuardTestUtils.isMutationToolResult('googleMail', output), false);
});
