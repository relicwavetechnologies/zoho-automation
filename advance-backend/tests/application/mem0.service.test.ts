import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Mem0Service, type Mem0MemoryClient } from '../../src/application/memory/mem0.service.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
};

class StubMemoryClient implements Mem0MemoryClient {
  readonly searches: Array<{ query: string; filters: Record<string, unknown> }> = [];
  readonly adds: Array<{ messages: unknown; config: Record<string, unknown> }> = [];
  readonly getAllCalls: Array<{ filters: Record<string, unknown> }> = [];
  readonly deletes: string[] = [];
  readonly deleteAllCalls: Array<{ userId?: string; agentId?: string }> = [];

  async add(messages: unknown, config: Record<string, unknown>) {
    this.adds.push({ messages, config });
    return { results: [] };
  }

  async search(query: string, config: { filters: Record<string, unknown> }) {
    this.searches.push({ query, filters: config.filters });
    const scope = config.filters.scope;
    if (scope === 'user') {
      return {
        results: [
          { id: 'u1', memory: 'User prefers tables.', score: 0.9 },
          { id: 'u2', memory: 'Low relevance fact.', score: 0.1 },
        ],
      };
    }
    if (scope === 'department') {
      return { results: [{ id: 'd1', memory: 'Team uses IST for daily ops.', score: 0.8 }] };
    }
    return { results: [{ id: 'c1', memory: 'User prefers tables.', score: 0.7 }] };
  }

  async getAll(config: { filters: Record<string, unknown> }) {
    this.getAllCalls.push({ filters: config.filters });
    const scope = config.filters.scope;
    if (scope === 'company') {
      return { results: [{ id: 'c1', memory: 'Company fact.' }, { id: 'c2', memory: 'Second company fact.' }] };
    }
    return { results: [{ id: 'm1', memory: 'Stored fact.' }] };
  }

  async delete(memoryId: string) {
    this.deletes.push(memoryId);
    return { message: 'deleted' };
  }

  async deleteAll(config: { userId?: string; agentId?: string }) {
    this.deleteAllCalls.push(config);
    return { message: 'deleted all' };
  }
}

class FailingSecondAddClient extends StubMemoryClient {
  private addCount = 0;

  constructor(private readonly failRollback = false) {
    super();
  }

  override async add(messages: unknown, config: Record<string, unknown>) {
    this.addCount++;
    this.adds.push({ messages, config });
    if (this.addCount === 2) throw new Error('second add failed');
    return {
      results: [{ id: 'stored-first', memory: String(messages) }],
    };
  }

  override async delete(memoryId: string) {
    this.deletes.push(memoryId);
    if (this.failRollback) throw new Error('rollback delete failed');
    return { message: 'deleted' };
  }
}

function makeService(memoryClient = new StubMemoryClient()) {
  return {
    memoryClient,
    service: new Mem0Service({
      openaiApiKey: 'sk-test',
      qdrantUrl: 'http://127.0.0.1:6333',
      collectionName: 'test_memories',
      extractionModel: 'gpt-4o-mini',
      maxResults: 10,
      logger: noopLogger,
      memoryClient,
    }),
  };
}

describe('Mem0Service', () => {
  it('searches user, department, and company scopes with stable shared entities', async () => {
    const { service, memoryClient } = makeService();

    const context = await service.searchForContext({
      query: 'what format should I use?',
      userId: 'user-1',
      companyId: 'co-1',
      departmentId: 'dept-1',
    });

    assert.match(context, /User memory:\n- User prefers tables\./);
    assert.match(context, /Team memory:\n- Team uses IST for daily ops\./);
    assert.equal(context.match(/User prefers tables/g)?.length, 1);
    assert.deepEqual(memoryClient.searches.map(call => call.filters), [
      { user_id: 'user-1', scope: 'user', company_id: 'co-1' },
      {
        agent_id: 'company:co-1:department:dept-1',
        scope: 'department',
        company_id: 'co-1',
        department_id: 'dept-1',
      },
      { agent_id: 'company:co-1', scope: 'company', company_id: 'co-1' },
    ]);
  });

  it('extracts manager conversations into user scope only (dept/company are explicit-only)', async () => {
    const { service, memoryClient } = makeService();

    await service.extractAndStore({
      userId: 'user-1',
      companyId: 'co-1',
      departmentId: 'dept-1',
      userRole: 'MANAGER',
      userMessage: 'Please remember that Finance prefers weekly revenue reports as tables.',
      assistantReply: '[Actions]\n- agent_lark_ops: ok\n\n[Reply]\nI will use tables for Finance reports going forward.',
    });

    assert.equal(memoryClient.adds.length, 1);
    assert.deepEqual(memoryClient.adds[0]?.config, {
      userId: 'user-1',
      metadata: {
        scope: 'user',
        company_id: 'co-1',
        owner_user_id: 'user-1',
        source: 'conversation',
      },
    });
    assert.deepEqual(memoryClient.adds[0]?.messages, [
      {
        role: 'user',
        content: 'Please remember that Finance prefers weekly revenue reports as tables.',
      },
      { role: 'assistant', content: 'I will use tables for Finance reports going forward.' },
    ]);
  });

  it('stores explicit company memories without LLM inference', async () => {
    const { service, memoryClient } = makeService();

    await service.rememberExplicit({
      fact: 'Acme uses net-30 payment terms.',
      scope: 'company',
      userId: 'user-1',
      companyId: 'co-1',
    });

    assert.deepEqual(memoryClient.adds, [{
      messages: 'Acme uses net-30 payment terms.',
      config: {
        agentId: 'company:co-1',
        metadata: {
          scope: 'company',
          company_id: 'co-1',
          owner_user_id: 'user-1',
          source: 'explicit',
        },
        infer: false,
      },
    }]);
  });

  it('stores every explicit batch fact as a non-inferred memory', async () => {
    const { service, memoryClient } = makeService();

    await service.rememberExplicitBatch({
      facts: ['First reviewed fact.', 'Second reviewed fact.'],
      scope: 'department',
      userId: 'user-1',
      companyId: 'co-1',
      departmentId: 'dept-1',
    });

    assert.deepEqual(memoryClient.adds, [
      {
        messages: 'First reviewed fact.',
        config: {
          agentId: 'company:co-1:department:dept-1',
          metadata: {
            scope: 'department',
            company_id: 'co-1',
            department_id: 'dept-1',
            owner_user_id: 'user-1',
            source: 'explicit',
          },
          infer: false,
        },
      },
      {
        messages: 'Second reviewed fact.',
        config: {
          agentId: 'company:co-1:department:dept-1',
          metadata: {
            scope: 'department',
            company_id: 'co-1',
            department_id: 'dept-1',
            owner_user_id: 'user-1',
            source: 'explicit',
          },
          infer: false,
        },
      },
    ]);
  });

  it('compensates completed writes when a later batch add fails', async () => {
    const memoryClient = new FailingSecondAddClient();
    const { service } = makeService(memoryClient);

    await assert.rejects(
      service.rememberExplicitBatch({
        facts: ['First reviewed fact.', 'Second reviewed fact.'],
        scope: 'company',
        userId: 'user-1',
        companyId: 'co-1',
      }),
      /completed writes were rolled back; no facts were published/,
    );
    assert.deepEqual(memoryClient.deletes, ['stored-first']);
  });

  it('surfaces indeterminate state when compensation fails', async () => {
    const memoryClient = new FailingSecondAddClient(true);
    const { service } = makeService(memoryClient);

    await assert.rejects(
      service.rememberExplicitBatch({
        facts: ['First reviewed fact.', 'Second reviewed fact.'],
        scope: 'company',
        userId: 'user-1',
        companyId: 'co-1',
      }),
      /state is indeterminate and must be reviewed before retrying/,
    );
    assert.deepEqual(memoryClient.deletes, ['stored-first']);
  });

  it('skips trivial conversations', async () => {
    const { service, memoryClient } = makeService();

    await service.extractAndStore({
      userId: 'user-1',
      companyId: 'co-1',
      userRole: 'MEMBER',
      userMessage: 'thanks',
      assistantReply: 'You are welcome.',
    });

    assert.equal(memoryClient.adds.length, 0);
  });

  it('filters low-score memories from retrieval context', async () => {
    const { service } = makeService();

    const context = await service.searchForContext({
      query: 'format preference',
      userId: 'user-1',
      companyId: 'co-1',
    });

    assert.match(context, /User prefers tables/);
    assert.doesNotMatch(context, /Low relevance fact/);
  });

  it('omits very short assistant replies from extraction input', async () => {
    const { service, memoryClient } = makeService();

    await service.extractAndStore({
      userId: 'user-1',
      companyId: 'co-1',
      userRole: 'MEMBER',
      userMessage: 'Please remember that I prefer invoice summaries as bullet lists.',
      assistantReply: 'Done.',
    });

    assert.deepEqual(memoryClient.adds[0]?.messages, [
      {
        role: 'user',
        content: 'Please remember that I prefer invoice summaries as bullet lists.',
      },
    ]);
  });

  it('returns memory stats by scope for the company', async () => {
    const { service, memoryClient } = makeService();

    const stats = await service.getMemoryStats({ companyId: 'co-1' });

    assert.deepEqual(stats, {
      totalUser: 1,
      totalDepartment: 1,
      totalCompany: 2,
    });
    assert.deepEqual(memoryClient.getAllCalls.map(call => call.filters), [
      { scope: 'user', company_id: 'co-1' },
      { scope: 'department', company_id: 'co-1' },
      { scope: 'company', company_id: 'co-1' },
    ]);
  });
});
