import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asCompanyId, asDepartmentId, asUserId } from '../../src/shared/ids.ts';
import { createRememberFactTool } from '../../src/application/orchestration/tools/orchestration/remember-fact.tool.ts';
import type { MemoryScope } from '../../src/application/memory/mem0.service.ts';

class StubMem0 {
  readonly remembered: Array<{
    fact: string;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }> = [];

  async rememberExplicit(input: {
    fact: string;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }) {
    this.remembered.push(input);
  }
}

function makeRunContext(role: string, departmentId?: string) {
  return {
    companyId: asCompanyId('co-1'),
    userId: asUserId('user-1'),
    companyRole: role,
    channel: 'test',
    ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
  } as any;
}

async function execute(tool: unknown, input: unknown): Promise<string> {
  return (tool as { execute: (input: unknown) => Promise<string> }).execute(input);
}

describe('rememberFact tool', () => {
  it('stores company facts for admins', async () => {
    const mem0 = new StubMem0();
    const tool = createRememberFactTool(mem0 as any, makeRunContext('COMPANY_ADMIN'));

    const result = await execute(tool, {
      fact: 'Acme uses net-60 payment terms.',
      scope: 'company',
    });

    assert.equal(result, 'Remembered for the company: "Acme uses net-60 payment terms."');
    assert.deepEqual(mem0.remembered[0], {
      fact: 'Acme uses net-60 payment terms.',
      scope: 'company',
      userId: 'user-1',
      companyId: 'co-1',
    });
  });

  it('downgrades company scope to user for members', async () => {
    const mem0 = new StubMem0();
    const tool = createRememberFactTool(mem0 as any, makeRunContext('MEMBER'));

    const result = await execute(tool, {
      fact: 'User prefers table summaries.',
      scope: 'company',
    });

    assert.equal(result, 'Remembered for this user: "User prefers table summaries."');
    assert.equal(mem0.remembered[0]?.scope, 'user');
  });

  it('stores department facts for managers with a department', async () => {
    const mem0 = new StubMem0();
    const tool = createRememberFactTool(mem0 as any, makeRunContext('MANAGER', 'dept-1'));

    const result = await execute(tool, {
      fact: 'Finance reviews refunds above 10K.',
      scope: 'department',
    });

    assert.equal(result, 'Remembered for the team: "Finance reviews refunds above 10K."');
    assert.deepEqual(mem0.remembered[0], {
      fact: 'Finance reviews refunds above 10K.',
      scope: 'department',
      userId: 'user-1',
      companyId: 'co-1',
      departmentId: 'dept-1',
    });
  });
});
