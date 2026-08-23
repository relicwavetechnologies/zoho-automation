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

describe('RuntimeApprovalRepository.createOrReuseActive', () => {
  it('serializes the PostgreSQL void lock result into a Prisma-supported scalar', async () => {
    let lockQuery = '';
    const prisma = {
      $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
        $queryRaw: async (strings: TemplateStringsArray) => {
          lockQuery = strings.join('?');
          return [{ lock_result: '' }];
        },
        runtimeApproval: {
          findFirst: async () => ({
            id: 'approval-1',
            status: 'pending',
            idempotencyKey: 'idempotency-1',
          }),
        },
      }),
    };
    const repo = new RuntimeApprovalRepository(prisma as any);

    const result = await repo.createOrReuseActive({
      chatId: 'chat-1',
      companyId: 'company-1',
      toolId: 'memory.publish',
      actionGroup: 'write',
      kind: 'tool_action',
      summary: 'Publish department memory',
      payloadJson: {},
      metadataJson: {},
      channel: 'lark',
      requestedBy: 'user-1',
      idempotencyKey: 'idempotency-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    assert.equal(result.ok, true);
    assert.match(lockQuery, /pg_advisory_xact_lock/);
    assert.match(lockQuery, /\)::text AS lock_result/);
  });
});

describe('RuntimeApprovalRepository.listDeliverableLarkSkillOutcomeIds', () => {
  it('does not require a card delivery when the Decision has no source message', async () => {
    let query = '';
    const repo = new RuntimeApprovalRepository({
      $queryRaw: async (strings: TemplateStringsArray) => {
        query = strings.join('?');
        return [];
      },
    } as any);

    assert.deepEqual(await repo.listDeliverableLarkSkillOutcomeIds(), []);
    assert.match(
      query,
      /approval\."decisionMessageId" IS NOT NULL\s+AND \(\s+card_delivery\."id" IS NULL/s,
    );
    assert.match(query, /OR message_delivery\."id" IS NULL/);
  });
});
