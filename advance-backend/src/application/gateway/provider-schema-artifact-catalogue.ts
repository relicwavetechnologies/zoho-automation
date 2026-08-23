import { createHash } from 'node:crypto';
import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

const ARTIFACT_VERSION = 1;
const MAX_SCHEMA_COUNT = 500;
const MAX_ARTIFACT_BYTES = 2_000_000;
const SHA256 = /^[a-f0-9]{64}$/;

export type ProviderSchemaArtifactProvider = 'google_workspace' | 'airtable';

export interface ProviderSchemaTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface ProviderSchemaArtifact {
  readonly provider: ProviderSchemaArtifactProvider;
  readonly partitionKey: string;
  readonly projectionRevision: string;
  readonly digest: string;
  readonly payload: string;
  readonly byteLength: number;
  readonly schemaCount: number;
  readonly checkedAt: Date;
  readonly expiresAt: Date;
}

export interface ProviderSchemaArtifactStore {
  readHead(input: {
    readonly provider: ProviderSchemaArtifactProvider;
    readonly partitionKey: string;
    readonly projectionRevision: string;
  }): Promise<Result<ProviderSchemaArtifact | null, InfraError>>;

  publish(artifact: ProviderSchemaArtifact): Promise<Result<void, InfraError>>;
}

export interface ProviderSchemaArtifactLogger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
}

export interface ProviderSchemaDescribeOptions {
  /** False starts one shared refresh and returns a miss instead of blocking this turn. */
  readonly waitForProvider?: boolean;
}

export interface ProviderSchemaArtifactCatalogueOptions<TTool extends ProviderSchemaTool> {
  readonly provider: ProviderSchemaArtifactProvider;
  readonly partitionKey: string;
  readonly projectionRevision: string;
  readonly approvedNames: ReadonlySet<string>;
  readonly project: (tool: TTool) => TTool;
  readonly store?: ProviderSchemaArtifactStore;
  readonly logger?: ProviderSchemaArtifactLogger;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * One durable owner for provider-owned schema content.
 *
 * The interface remains the existing `describe(name, loadAll)` seam. Behind it,
 * a process-local map is only an L1 over a content-addressed durable artifact.
 * Provider credentials authenticate `loadAll`; they are never part of the
 * artifact, its key, or its payload.
 */
export class ProviderSchemaArtifactCatalogue<TTool extends ProviderSchemaTool> {
  private readonly provider: ProviderSchemaArtifactProvider;
  private readonly partitionKey: string;
  private readonly projectionRevision: string;
  private readonly approvedNames: ReadonlySet<string>;
  private readonly project: (tool: TTool) => TTool;
  private readonly store: ProviderSchemaArtifactStore | undefined;
  private readonly logger: ProviderSchemaArtifactLogger | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private snapshot: ReadonlyMap<string, TTool> | undefined;
  private snapshotExpiresAtMs = 0;
  private loading: Promise<ReadonlyMap<string, TTool>> | undefined;
  private forceRefresh = false;
  private generation = 0;

  constructor(options: ProviderSchemaArtifactCatalogueOptions<TTool>) {
    if (!options.partitionKey || options.partitionKey.length > 500) {
      throw new Error('Provider schema artifact partition key is invalid');
    }
    if (!options.projectionRevision || options.projectionRevision.length > 300) {
      throw new Error('Provider schema artifact projection revision is invalid');
    }
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new Error('Provider schema artifact TTL must be positive');
    }
    this.provider = options.provider;
    this.partitionKey = options.partitionKey;
    this.projectionRevision = options.projectionRevision;
    this.approvedNames = options.approvedNames;
    this.project = options.project;
    this.store = options.store;
    this.logger = options.logger;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async describe(
    name: string,
    loadAll: () => Promise<readonly TTool[]>,
    options: ProviderSchemaDescribeOptions = {},
  ): Promise<TTool | null> {
    if (!this.approvedNames.has(name)) return null;
    const current = this.currentSnapshot();
    if (current) return current.get(name) ?? null;
    const refreshAlreadyRunning = this.loading !== undefined;
    const pending = this.load(loadAll);
    if (options.waitForProvider === false) {
      if (!refreshAlreadyRunning) {
        this.logger?.info('provider_schema_artifact.background_refresh_started', {
          provider: this.provider,
        });
        void pending.catch(error => {
          this.logger?.warn('provider_schema_artifact.background_refresh_failed', {
            provider: this.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return null;
    }
    const schemas = await pending;
    return schemas.get(name) ?? null;
  }

  /** Force the next read to refresh from the provider rather than trust a durable head. */
  invalidate(): void {
    this.generation += 1;
    this.snapshot = undefined;
    this.snapshotExpiresAtMs = 0;
    this.loading = undefined;
    this.forceRefresh = true;
  }

  private async load(
    loadAll: () => Promise<readonly TTool[]>,
  ): Promise<ReadonlyMap<string, TTool>> {
    const current = this.currentSnapshot();
    if (current) return current;
    if (this.loading) return this.loading;

    const startedAt = this.now();
    const generation = this.generation;
    const pending = this.loadSnapshot(loadAll).then(({ schemas, source, expiresAtMs }) => {
      if (generation !== this.generation) {
        this.logger?.info('provider_schema_artifact.stale_refresh_discarded', {
          provider: this.provider,
        });
        return schemas;
      }
      this.snapshot = schemas;
      this.snapshotExpiresAtMs = expiresAtMs;
      this.forceRefresh = false;
      this.logger?.info('provider_schema_artifact.ready', {
        provider: this.provider,
        source,
        schemaCount: schemas.size,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      return schemas;
    });
    this.loading = pending;
    try {
      return await pending;
    } finally {
      if (this.loading === pending) this.loading = undefined;
    }
  }

  private async loadSnapshot(
    loadAll: () => Promise<readonly TTool[]>,
  ): Promise<{
    schemas: ReadonlyMap<string, TTool>;
    source: 'durable' | 'provider';
    expiresAtMs: number;
  }> {
    if (this.store && !this.forceRefresh) {
      const stored = await this.store.readHead({
        provider: this.provider,
        partitionKey: this.partitionKey,
        projectionRevision: this.projectionRevision,
      });
      if (!stored.ok) {
        this.logger?.warn('provider_schema_artifact.read_failed', {
          provider: this.provider,
          error: stored.error.message,
        });
      } else if (stored.value && stored.value.expiresAt.getTime() > this.now()) {
        try {
          return {
            schemas: this.parseArtifact(stored.value),
            source: 'durable',
            expiresAtMs: stored.value.expiresAt.getTime(),
          };
        } catch (error) {
          this.logger?.warn('provider_schema_artifact.corrupt', {
            provider: this.provider,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (stored.value) {
        this.logger?.info('provider_schema_artifact.expired', {
          provider: this.provider,
          expiredAt: stored.value.expiresAt.toISOString(),
        });
      }
    }

    const schemas = this.projectProviderSchemas(await loadAll());
    const artifact = this.createArtifact(schemas);
    if (this.store) {
      const published = await this.store.publish(artifact);
      if (!published.ok) {
        this.logger?.warn('provider_schema_artifact.publish_failed', {
          provider: this.provider,
          error: published.error.message,
        });
      }
    }
    return { schemas, source: 'provider', expiresAtMs: artifact.expiresAt.getTime() };
  }

  private currentSnapshot(): ReadonlyMap<string, TTool> | undefined {
    if (!this.snapshot) return undefined;
    if (this.snapshotExpiresAtMs > this.now()) return this.snapshot;
    this.snapshot = undefined;
    this.snapshotExpiresAtMs = 0;
    return undefined;
  }

  private projectProviderSchemas(tools: readonly TTool[]): ReadonlyMap<string, TTool> {
    if (tools.length > MAX_SCHEMA_COUNT) {
      throw new Error(`Provider schema catalogue exceeds ${MAX_SCHEMA_COUNT} entries`);
    }
    const projected = new Map<string, TTool>();
    for (const tool of tools) {
      if (!this.approvedNames.has(tool.name)) continue;
      const candidate = this.project(tool);
      if (
        !this.approvedNames.has(candidate.name)
        || !Object.hasOwn(candidate, 'inputSchema')
        || (candidate.description !== undefined && typeof candidate.description !== 'string')
      ) {
        throw new Error('Provider schema projection returned an invalid tool');
      }
      // Persist the schema contract only. A provider adapter object may carry
      // transport state at runtime despite its static type; spreading it here
      // would turn a cache artifact into a credential sink.
      const value = {
        name: candidate.name,
        ...(candidate.description ? { description: candidate.description } : {}),
        inputSchema: candidate.inputSchema,
      } as TTool;
      if (projected.has(value.name)) {
        throw new Error(`Provider schema catalogue contains duplicate tool ${value.name}`);
      }
      projected.set(value.name, value);
    }
    return new Map([...projected].sort(([left], [right]) => left.localeCompare(right)));
  }

  private createArtifact(schemas: ReadonlyMap<string, TTool>): ProviderSchemaArtifact {
    const payload = JSON.stringify({
      version: ARTIFACT_VERSION,
      provider: this.provider,
      partitionKey: this.partitionKey,
      projectionRevision: this.projectionRevision,
      tools: [...schemas.values()],
    });
    const byteLength = Buffer.byteLength(payload, 'utf8');
    if (byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`Provider schema artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const checkedAt = new Date(this.now());
    return {
      provider: this.provider,
      partitionKey: this.partitionKey,
      projectionRevision: this.projectionRevision,
      digest: digest(payload),
      payload,
      byteLength,
      schemaCount: schemas.size,
      checkedAt,
      expiresAt: new Date(checkedAt.getTime() + this.ttlMs),
    };
  }

  private parseArtifact(artifact: ProviderSchemaArtifact): ReadonlyMap<string, TTool> {
    if (
      artifact.provider !== this.provider
      || artifact.partitionKey !== this.partitionKey
      || artifact.projectionRevision !== this.projectionRevision
      || !SHA256.test(artifact.digest)
      || artifact.byteLength !== Buffer.byteLength(artifact.payload, 'utf8')
      || artifact.digest !== digest(artifact.payload)
    ) {
      throw new Error('Provider schema artifact identity or digest is invalid');
    }
    if (artifact.byteLength > MAX_ARTIFACT_BYTES || artifact.schemaCount > MAX_SCHEMA_COUNT) {
      throw new Error('Provider schema artifact exceeds its declared bounds');
    }
    const parsed: unknown = JSON.parse(artifact.payload);
    if (!isRecord(parsed)) throw new Error('Provider schema artifact payload is not an object');
    if (
      parsed['version'] !== ARTIFACT_VERSION
      || parsed['provider'] !== this.provider
      || parsed['partitionKey'] !== this.partitionKey
      || parsed['projectionRevision'] !== this.projectionRevision
      || !Array.isArray(parsed['tools'])
      || parsed['tools'].length !== artifact.schemaCount
    ) {
      throw new Error('Provider schema artifact payload metadata is invalid');
    }
    const schemas = new Map<string, TTool>();
    for (const candidate of parsed['tools']) {
      if (!isRecord(candidate)) throw new Error('Provider schema artifact contains a malformed tool');
      const name = candidate['name'];
      if (
        typeof name !== 'string'
        || !this.approvedNames.has(name)
        || !Object.hasOwn(candidate, 'inputSchema')
        || schemas.has(name)
      ) {
        throw new Error('Provider schema artifact contains an unapproved or duplicate tool');
      }
      const description = candidate['description'];
      if (description !== undefined && typeof description !== 'string') {
        throw new Error('Provider schema artifact contains an invalid description');
      }
      schemas.set(name, {
        name,
        ...(description ? { description } : {}),
        inputSchema: candidate['inputSchema'],
      } as TTool);
    }
    return schemas;
  }
}

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** Preserve endpoint identity without storing credentials or routing tokens from its URL. */
export function providerSchemaArtifactPartitionKey(endpoint: string): string {
  const normalized = endpoint.trim();
  if (!normalized) throw new Error('Provider schema artifact endpoint is empty');
  return `endpoint-sha256:${digest(normalized)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
