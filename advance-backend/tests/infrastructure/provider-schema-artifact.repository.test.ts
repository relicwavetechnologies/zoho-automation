import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderSchemaArtifactRepository } from '../../src/infrastructure/persistence/provider-schema-artifact.repository.ts';

const artifact = {
  provider: 'google_workspace' as const,
  partitionKey: 'http://workspace-mcp/mcp',
  projectionRevision: '1.22.2:sanitizer-v1',
  digest: 'a'.repeat(64),
  payload: '{"version":1}',
  byteLength: 13,
  schemaCount: 1,
  checkedAt: new Date('2026-08-23T00:00:00.000Z'),
  expiresAt: new Date('2026-08-24T00:00:00.000Z'),
};

describe('ProviderSchemaArtifactRepository', () => {
  it('publishes immutable bytes before atomically moving the provider head', async () => {
    const operations: Array<{ kind: string; input: unknown }> = [];
    const transaction = {
      providerSchemaArtifact: {
        upsert: async (input: unknown) => {
          operations.push({ kind: 'artifact', input });
          return { id: 'artifact-1' };
        },
      },
      providerSchemaArtifactHead: {
        findUnique: async (input: unknown) => {
          operations.push({ kind: 'head-read', input });
          return null;
        },
        upsert: async (input: unknown) => {
          operations.push({ kind: 'head', input });
          return {};
        },
      },
    };
    const repo = new ProviderSchemaArtifactRepository({
      $transaction: async (work: (tx: typeof transaction) => Promise<void>) => work(transaction),
    } as never);

    const result = await repo.publish(artifact);

    assert.equal(result.ok, true);
    assert.deepEqual(operations.map(operation => operation.kind), ['artifact', 'head-read', 'head']);
    const artifactInput = operations[0]?.input as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    assert.deepEqual(artifactInput.create, {
      provider: artifact.provider,
      partitionKey: artifact.partitionKey,
      projectionRevision: artifact.projectionRevision,
      digest: artifact.digest,
      payload: artifact.payload,
      byteLength: artifact.byteLength,
      schemaCount: artifact.schemaCount,
    });
    const headInput = operations[2]?.input as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    assert.equal(headInput.create['artifactId'], 'artifact-1');
    assert.equal(headInput.create['checkedAt'], artifact.checkedAt);
    assert.equal(headInput.create['expiresAt'], artifact.expiresAt);
    assert.deepEqual(headInput.update, {
      artifactId: 'artifact-1',
      checkedAt: artifact.checkedAt,
      expiresAt: artifact.expiresAt,
    });
  });

  it('reads the current head without exposing repository-only row fields', async () => {
    let query: unknown;
    const repo = new ProviderSchemaArtifactRepository({
      providerSchemaArtifactHead: {
        findUnique: async (input: unknown) => {
          query = input;
          return {
            checkedAt: artifact.checkedAt,
            expiresAt: artifact.expiresAt,
            artifact: {
              id: 'artifact-1',
              createdAt: new Date('2026-08-22T00:00:00.000Z'),
              provider: artifact.provider,
              partitionKey: artifact.partitionKey,
              projectionRevision: artifact.projectionRevision,
              digest: artifact.digest,
              payload: artifact.payload,
              byteLength: artifact.byteLength,
              schemaCount: artifact.schemaCount,
            },
          };
        },
      },
    } as never);

    const result = await repo.readHead({
      provider: artifact.provider,
      partitionKey: artifact.partitionKey,
      projectionRevision: artifact.projectionRevision,
    });

    assert.deepEqual(result, { ok: true, value: artifact });
    assert.deepEqual(query, {
      where: {
        provider_partitionKey_projectionRevision: {
          provider: artifact.provider,
          partitionKey: artifact.partitionKey,
          projectionRevision: artifact.projectionRevision,
        },
      },
      include: { artifact: true },
    });
  });

  it('does not let an older concurrent refresh move the current head backward', async () => {
    let headWrites = 0;
    const repo = new ProviderSchemaArtifactRepository({
      $transaction: async (work: (tx: unknown) => Promise<void>) => work({
        providerSchemaArtifact: {
          upsert: async () => ({ id: 'older-artifact' }),
        },
        providerSchemaArtifactHead: {
          findUnique: async () => ({
            checkedAt: new Date(artifact.checkedAt.getTime() + 1_000),
          }),
          upsert: async () => { headWrites += 1; },
        },
      }),
    } as never);

    const result = await repo.publish(artifact);

    assert.equal(result.ok, true);
    assert.equal(headWrites, 0);
  });

  it('keeps database failures inside the structured repository result', async () => {
    const repo = new ProviderSchemaArtifactRepository({
      providerSchemaArtifactHead: {
        findUnique: async () => { throw new Error('database unavailable'); },
      },
    } as never);

    const result = await repo.readHead({
      provider: artifact.provider,
      partitionKey: artifact.partitionKey,
      projectionRevision: artifact.projectionRevision,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.payload.op, 'provider_schema_artifact.read_head');
      assert.equal(result.error.message, 'database unavailable');
    }
  });
});
