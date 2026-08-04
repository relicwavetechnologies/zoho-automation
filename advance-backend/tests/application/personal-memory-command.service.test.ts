import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonalMemoryCommandService } from '../../src/application/knowledge/personal-memory-command.service.ts';
import { ok, err } from '../../src/shared/result.ts';
import { PermissionError } from '../../src/shared/errors.ts';

const identity = {
  companyId: 'company-1',
  userId: 'user-1',
  companyRole: 'MEMBER',
  channel: 'lark' as const,
};

function resource(facts = ['The user prefers detailed answers.']) {
  return {
    resourceId: '11111111-1111-4111-8111-111111111111',
    kind: 'memory' as const,
    scope: 'personal' as const,
    logicalKey: 'communication.answers.detail',
    currentVersion: 2,
    title: 'communication.answers.detail',
    summary: '1 durable fact',
    updatedAt: '2026-07-31T00:00:00.000Z',
    content: { facts },
  };
}

function fixture(
  current: ReturnType<typeof resource> | null,
  allow: boolean | ((action: string) => boolean) = true,
  semanticMatches?: ReturnType<typeof resource>[],
) {
  const proposals: any[] = [];
  const permissions: string[] = [];
  const projected: string[] = [];
  const service = new PersonalMemoryCommandService({
    permissions: {
      canInvoke: async (_context, capability) => {
        permissions.push(String(capability.action));
        const permitted = typeof allow === 'function'
          ? allow(String(capability.action))
          : allow;
        return permitted
          ? ok(undefined)
          : err(new PermissionError({
              toolId: 'knowledge',
              action: capability.action,
              reason: 'not_allowed',
              message: 'denied',
            }));
      },
    },
    resources: {
      getPersonalMemoryByLogicalKey: async () => current,
      searchMemories: async () => (semanticMatches ?? (current ? [current] : [])).map(match => ({
        resource: match,
        score: 1,
        coverage: 1,
      })),
    },
    mutations: {
      propose: async (input: unknown) => {
        proposals.push(input);
        return { id: 'mutation-1', companyId: 'company-1', status: 'approved' };
      },
      apply: async () => ({
        resourceId: current?.resourceId ?? '22222222-2222-4222-8222-222222222222',
        version: current ? current.currentVersion + 1 : 1,
      }),
    } as any,
    projections: {
      projectMutation: async (mutationId: string) => { projected.push(mutationId); },
    } as any,
  });
  return { service, proposals, permissions, projected };
}

describe('personal memory command service', () => {
  it('creates an exact personal memory through RBAC, policy, versioning, and projection', async () => {
    const test = fixture(null);
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['The user prefers detailed answers.'],
      },
      sourceRef: 'run-1',
    });

    assert.deepEqual(result, {
      action: 'created',
      logicalKey: 'communication.answers.detail',
      resourceId: '22222222-2222-4222-8222-222222222222',
      version: 1,
      projection: 'queued',
    });
    assert.deepEqual(test.permissions, ['read', 'create']);
    assert.equal(test.proposals[0].target.scope, 'personal');
    assert.equal(test.proposals[0].target.userId, 'user-1');
    assert.equal('baseVersion' in test.proposals[0], false);
    assert.deepEqual(test.projected, ['mutation-1']);
  });

  it('updates the canonical current version instead of creating a duplicate', async () => {
    const test = fixture(resource());
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['The user prefers very detailed answers.'],
      },
    });

    assert.equal(result.action, 'updated');
    assert.deepEqual(test.permissions, ['read', 'update']);
    assert.equal(test.proposals[0].action, 'update');
    assert.equal(test.proposals[0].baseVersion, 2);
  });

  it('resolves a changed proposed key to one canonical subject instead of creating a duplicate', async () => {
    const current = resource();
    const test = fixture(null, true, [current]);
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'answers.preferred.detail.level',
        facts: ['The user prefers very detailed answers.'],
      },
    });

    assert.equal(result.action, 'updated');
    assert.equal(result.logicalKey, current.logicalKey);
    assert.equal(test.proposals[0].logicalKey, current.logicalKey);
    assert.equal(test.proposals[0].action, 'update');
    assert.equal(test.proposals[0].baseVersion, 2);
  });

  it('fails closed when a natural subject matches more than one current memory', async () => {
    const first = resource();
    const second = {
      ...resource(['The user prefers concise answers.']),
      resourceId: '33333333-3333-4333-8333-333333333333',
      logicalKey: 'communication.response.detail',
    };
    const test = fixture(null, true, [first, second]);

    await assert.rejects(
      test.service.execute({
        ...identity,
        command: {
          action: 'set',
          subject: 'answer detail preference',
          logicalKey: 'answers.detail',
          facts: ['The user prefers very detailed answers.'],
        },
      }),
      /more than one personal memory/i,
    );
    assert.deepEqual(test.permissions, ['read']);
    assert.deepEqual(test.proposals, []);
  });

  it('denies an exact-facts no-op before returning its unchanged result', async () => {
    const test = fixture(resource(), action => action === 'read');

    await assert.rejects(
      test.service.execute({
        ...identity,
        command: {
          action: 'set',
          subject: 'answer detail preference',
          logicalKey: 'communication.answers.detail',
          facts: ['The user prefers detailed answers.'],
        },
      }),
      /denied/i,
    );
    assert.deepEqual(test.permissions, ['read', 'update']);
    assert.deepEqual(test.proposals, []);
  });

  it('rejects a subject that resolves to a different exact logical key', async () => {
    const current = resource();
    const different = {
      ...resource(['The user prefers concise answers.']),
      resourceId: '33333333-3333-4333-8333-333333333333',
      logicalKey: 'communication.response.detail',
    };
    const test = fixture(current, true, [different]);

    await assert.rejects(
      test.service.execute({
        ...identity,
        command: {
          action: 'delete',
          subject: 'concise response preference',
          logicalKey: current.logicalKey,
        },
      }),
      /logical key and subject do not identify the same/i,
    );
    assert.deepEqual(test.permissions, ['read']);
    assert.deepEqual(test.proposals, []);
  });

  it('rejects an exact logical key when the supplied subject matches no memory', async () => {
    const test = fixture(resource(), true, []);

    await assert.rejects(
      test.service.execute({
        ...identity,
        command: {
          action: 'delete',
          subject: 'an unrelated topic',
          logicalKey: 'communication.answers.detail',
        },
      }),
      /logical key and subject do not identify the same/i,
    );
    assert.deepEqual(test.permissions, ['read']);
    assert.deepEqual(test.proposals, []);
  });

  it('does not claim immediate projection completion for a committed mutation', async () => {
    const test = fixture(null);
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['The user prefers detailed answers.'],
      },
    });

    assert.equal(result.projection, 'queued');
  });

  it('returns a verified no-op for the exact existing facts', async () => {
    const test = fixture(resource());
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'set',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
        facts: ['The user prefers detailed answers.'],
      },
    });

    assert.equal(result.action, 'unchanged');
    assert.equal(result.projection, 'queued');
    assert.deepEqual(test.permissions, ['read', 'update']);
    assert.deepEqual(test.proposals, []);
  });

  it('deletes only an exact existing subject with its current version', async () => {
    const test = fixture(resource());
    const result = await test.service.execute({
      ...identity,
      command: {
        action: 'delete',
        subject: 'answer detail preference',
        logicalKey: 'communication.answers.detail',
      },
    });

    assert.equal(result.action, 'deleted');
    assert.deepEqual(test.permissions, ['read', 'delete']);
    assert.equal(test.proposals[0].action, 'delete');
    assert.equal(test.proposals[0].baseVersion, 2);
    assert.equal('content' in test.proposals[0], false);
  });

  it('fails before proposing when live RBAC denies the resolved action', async () => {
    const test = fixture(null, false);

    await assert.rejects(
      test.service.execute({
        ...identity,
        command: {
          action: 'set',
          subject: 'answer detail preference',
          logicalKey: 'communication.answers.detail',
          facts: ['The user prefers detailed answers.'],
        },
      }),
      /denied/i,
    );
    assert.deepEqual(test.proposals, []);
  });
});
