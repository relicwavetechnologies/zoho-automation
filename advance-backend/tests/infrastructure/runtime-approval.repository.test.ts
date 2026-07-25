import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuntimeApprovalRepository } from '../../src/infrastructure/persistence/runtime-approval.repository';

describe('RuntimeApprovalRepository.claimApprovedExecution', () => {
  it('returns the authoritative company from the approval conversation', async () => {
    let findArgs: unknown;
    const prisma = {
      runtimeApproval: {
        updateMany: async () => ({ count: 1 }),
        findMany: async (args: unknown) => {
          findArgs = args;
          return [{
            id: 'approval-1',
            requestedBy: 'user-1',
            status: 'executing',
            conversation: { companyId: 'company-1' },
          }];
        },
      },
      $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
    };
    const repo = new RuntimeApprovalRepository(prisma as any);

    const result = await repo.claimApprovedExecution('approval-1', 'user-1');

    assert.ok(result.ok && result.value);
    assert.equal(result.value.companyId, 'company-1');
    assert.equal('conversation' in result.value, false);
    assert.deepEqual(findArgs, {
      where: { id: 'approval-1' },
      include: {
        conversation: {
          select: { companyId: true },
        },
      },
    });
  });
});
