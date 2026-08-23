import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InfraError } from '../../src/shared/errors.ts';
import { err, ok } from '../../src/shared/result.ts';
import {
  ProviderSchemaArtifactCatalogue,
  providerSchemaArtifactPartitionKey,
  type ProviderSchemaArtifact,
  type ProviderSchemaArtifactLogger,
  type ProviderSchemaArtifactStore,
} from '../../src/application/gateway/provider-schema-artifact-catalogue.ts';

interface ToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

class MemoryStore implements ProviderSchemaArtifactStore {
  artifact: ProviderSchemaArtifact | null = null;
  reads = 0;
  publishes = 0;
  readError = false;
  publishError = false;

  async readHead() {
    this.reads += 1;
    return this.readError
      ? err(new InfraError({ layer: 'prisma', op: 'read', cause: new Error('offline') }))
      : ok(this.artifact);
  }

  async publish(artifact: ProviderSchemaArtifact) {
    this.publishes += 1;
    if (this.publishError) {
      return err(new InfraError({ layer: 'prisma', op: 'publish', cause: new Error('offline') }));
    }
    this.artifact = artifact;
    return ok(undefined);
  }
}

function catalogue(input: {
  store?: ProviderSchemaArtifactStore;
  logger?: ProviderSchemaArtifactLogger;
  now?: () => number;
  ttlMs?: number;
} = {}) {
  return new ProviderSchemaArtifactCatalogue<ToolDescription>({
    provider: 'google_workspace',
    partitionKey: 'reviewed-global',
    projectionRevision: 'test-v1',
    approvedNames: new Set(['search_messages', 'create_sheet']),
    project: tool => ({ ...tool, description: tool.description?.trim() }),
    ...input,
  });
}

const providerTools = [{
  name: 'search_messages',
  description: ' Search messages. ',
  inputSchema: { type: 'object' },
}];

describe('ProviderSchemaArtifactCatalogue', () => {
  it('survives process-memory loss without another provider call', async () => {
    const store = new MemoryStore();
    let providerCalls = 0;
    const first = catalogue({ store });
    assert.equal((await first.describe('search_messages', async () => {
      providerCalls += 1;
      return providerTools;
    }))?.description, 'Search messages.');

    const restarted = catalogue({ store });
    assert.equal((await restarted.describe('search_messages', async () => {
      providerCalls += 1;
      throw new Error('provider must not be called on a durable hit');
    }))?.name, 'search_messages');

    assert.equal(providerCalls, 1);
    assert.equal(store.publishes, 1);
    assert.equal(store.reads, 2);
  });

  it('refreshes an expired durable artifact exactly once', async () => {
    const store = new MemoryStore();
    let now = 1_000;
    let providerCalls = 0;
    const first = catalogue({ store, now: () => now, ttlMs: 100 });
    await first.describe('search_messages', async () => {
      providerCalls += 1;
      return providerTools;
    });

    now = 1_101;
    const restarted = catalogue({ store, now: () => now, ttlMs: 100 });
    const [left, right] = await Promise.all([
      restarted.describe('search_messages', async () => {
        providerCalls += 1;
        return providerTools;
      }),
      restarted.describe('search_messages', async () => {
        providerCalls += 1;
        return providerTools;
      }),
    ]);

    assert.equal(left?.name, 'search_messages');
    assert.deepEqual(right, left);
    assert.equal(providerCalls, 2);
    assert.equal(store.publishes, 2);
  });

  it('does not let the process-local L1 outlive the artifact TTL', async () => {
    let now = 2_000;
    let providerCalls = 0;
    const current = catalogue({ now: () => now, ttlMs: 100 });
    const load = async () => {
      providerCalls += 1;
      return providerTools;
    };

    await current.describe('search_messages', load);
    now = 2_101;
    await current.describe('search_messages', load);

    assert.equal(providerCalls, 2);
  });

  it('starts one non-blocking refresh and lets an actual describe await it', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let providerCalls = 0;
    const infoEvents: string[] = [];
    const current = catalogue({
      logger: {
        info: event => { infoEvents.push(event); },
        warn: () => {},
      },
    });
    const load = async () => {
      providerCalls += 1;
      await gate;
      return providerTools;
    };

    const speculative = await current.describe(
      'search_messages',
      load,
      { waitForProvider: false },
    );
    const duplicateSpeculative = await current.describe(
      'search_messages',
      load,
      { waitForProvider: false },
    );
    const required = current.describe('search_messages', load);
    assert.equal(speculative, null);
    assert.equal(duplicateSpeculative, null);
    assert.equal(providerCalls, 1);
    assert.equal(
      infoEvents.filter(event => event === 'provider_schema_artifact.background_refresh_started').length,
      1,
    );

    release();
    assert.equal((await required)?.name, 'search_messages');
    assert.equal(providerCalls, 1);
  });

  it('does not let an invalidated in-flight refresh replace the newer snapshot', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const current = catalogue();
    const oldLoad = current.describe('search_messages', async () => {
      await oldGate;
      return [{ ...providerTools[0], description: 'Old schema.' }];
    });

    current.invalidate();
    const fresh = await current.describe('search_messages', async () => [
      { ...providerTools[0], description: 'Fresh schema.' },
    ]);
    assert.equal(fresh?.description, 'Fresh schema.');

    releaseOld();
    assert.equal((await oldLoad)?.description, 'Old schema.');
    const retained = await current.describe('search_messages', async () => {
      throw new Error('the stale refresh must not evict the fresh L1');
    });
    assert.equal(retained?.description, 'Fresh schema.');
  });

  it('rejects corrupt durable bytes and replaces them from the provider', async () => {
    const store = new MemoryStore();
    await catalogue({ store }).describe('search_messages', async () => providerTools);
    assert.ok(store.artifact);
    store.artifact = { ...store.artifact, payload: `${store.artifact.payload}corrupt` };
    let providerCalls = 0;

    const result = await catalogue({ store }).describe('search_messages', async () => {
      providerCalls += 1;
      return providerTools;
    });

    assert.equal(result?.name, 'search_messages');
    assert.equal(providerCalls, 1);
    assert.equal(store.publishes, 2);
  });

  it('reports store failures while preserving the current provider result', async () => {
    const store = new MemoryStore();
    store.readError = true;
    store.publishError = true;
    const warnings: string[] = [];
    const logger: ProviderSchemaArtifactLogger = {
      info: () => {},
      warn: event => { warnings.push(event); },
    };

    const result = await catalogue({ store, logger }).describe(
      'search_messages',
      async () => providerTools,
    );

    assert.equal(result?.name, 'search_messages');
    assert.deepEqual(warnings, [
      'provider_schema_artifact.read_failed',
      'provider_schema_artifact.publish_failed',
    ]);
  });

  it('persists only schema fields even when an adapter object carries transport state', async () => {
    const store = new MemoryStore();
    const leaked = {
      ...providerTools[0],
      accessToken: 'must-not-be-stored',
      connectionId: 'must-not-be-stored',
    };

    await catalogue({ store }).describe('search_messages', async () => [leaked]);

    assert.ok(store.artifact);
    assert.doesNotMatch(store.artifact.payload, /must-not-be-stored|accessToken|connectionId/);
  });

  it('does no store or provider work for an unapproved tool', async () => {
    const store = new MemoryStore();
    let providerCalls = 0;
    const result = await catalogue({ store }).describe('delete_everything', async () => {
      providerCalls += 1;
      return providerTools;
    });

    assert.equal(result, null);
    assert.equal(providerCalls, 0);
    assert.equal(store.reads, 0);
  });

  it('partitions by endpoint identity without persisting endpoint secrets', () => {
    const endpoint = 'https://member:secret@example.test/mcp?routing_token=sensitive';
    const partitionKey = providerSchemaArtifactPartitionKey(endpoint);

    assert.match(partitionKey, /^endpoint-sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(partitionKey, /member|secret|routing_token|sensitive|example/);
    assert.equal(partitionKey, providerSchemaArtifactPartitionKey(endpoint));
    assert.notEqual(partitionKey, providerSchemaArtifactPartitionKey(`${endpoint}2`));
  });
});
