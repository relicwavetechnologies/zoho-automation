import { createHash } from 'crypto';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import type { VectorUpsertDTO } from '../../contracts';
import type {
  VectorDeleteBySourceInput,
  VectorPointUpsert,
  VectorSearchGroup,
  VectorSearchQuery,
  VectorSearchResult,
  VectorStoreAdapter,
  VectorStoreHealth,
} from './vector-store.adapter';
import {
  ACTIVE_EMBEDDING_SCHEMA_VERSION,
  MULTIMODAL_VECTOR_NAME,
  PRIMARY_TEXT_VECTOR_NAME,
  type RetrievalProfile,
} from './retrieval-contract';

export type QdrantUpsertInput = VectorUpsertDTO & {
  connectionId?: string;
  denseEmbedding: number[];
  multimodalEmbedding?: number[];
  updatedAt?: string;
  embeddingSchemaVersion?: string;
  retrievalProfile?: RetrievalProfile;
  title?: string;
  content?: string;
  documentKey?: string;
  sourceUpdatedAt?: string;
};

type QdrantPoint = {
  id: string | number;
  vector: Record<string, number[]>;
  payload: Record<string, unknown>;
};

type QdrantCountResponse = {
  result?: {
    count?: number;
  };
};

type QdrantGroupHit = {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
};

type QdrantGroupsResponse = {
  result?:
    | {
        groups?: Array<{
          id?: string | number;
          hits?: QdrantGroupHit[];
        }>;
      }
    | Array<{
        id?: string | number;
        hits?: QdrantGroupHit[];
      }>;
};

class VectorStoreError extends Error {
  readonly code: 'vector_timeout' | 'vector_unavailable';

  constructor(message: string, code: 'vector_timeout' | 'vector_unavailable') {
    super(message);
    this.name = 'VectorStoreError';
    this.code = code;
  }
}

const OPENAI_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

const resolvePrimaryTextVectorSize = (): number => {
  if (config.EMBEDDING_PROVIDER === 'openai') {
    return OPENAI_DIMENSIONS[config.OPENAI_EMBEDDING_MODEL] ?? 1536;
  }
  if (config.EMBEDDING_PROVIDER === 'fallback') {
    return 1536;
  }
  return 3072;
};

const resolveMultimodalVectorSize = (): number => 3072;

const isCollectionNotFoundError = (error: unknown): error is VectorStoreError =>
  error instanceof VectorStoreError && error.message.includes('(404)');

const isMissingPayloadIndexError = (error: unknown): error is VectorStoreError =>
  error instanceof VectorStoreError && error.message.includes('Index required but not found');

const buildPointId = (point: {
  companyId: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
}): string => {
  const seed = createHash('sha1')
    .update(`${point.companyId}|${point.sourceType}|${point.sourceId}|${point.chunkIndex}`)
    .digest('hex')
    .slice(0, 32)
    .padEnd(32, '0');

  const chars = seed.split('');
  chars[12] = '5';
  const variant = Number.parseInt(chars[16] ?? '0', 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const normalized = chars.join('');

  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join('-');
};

const buildScopeShouldClauses = (query: VectorSearchQuery): Array<Record<string, unknown>> => {
  const should: Array<Record<string, unknown>> = [];
  const includePublic = query.includePublic ?? true;
  const includeShared = query.includeShared ?? true;
  const includePersonal = (query.includePersonal ?? true) && Boolean(query.requesterUserId);

  if (includePublic) {
    should.push({
      must: [{ key: 'visibility', match: { value: 'public' } }],
    });
  }

  if (includeShared) {
    should.push({
      must: [
        { key: 'companyId', match: { value: query.companyId } },
        { key: 'visibility', match: { value: 'shared' } },
      ],
    });
  }

  if (includePersonal && query.requesterUserId) {
    should.push({
      must: [
        { key: 'companyId', match: { value: query.companyId } },
        { key: 'visibility', match: { value: 'personal' } },
        { key: 'ownerUserId', match: { value: query.requesterUserId } },
      ],
    });
  }

  if (should.length === 0) {
    should.push({
      must: [{ key: 'companyId', match: { value: query.companyId } }],
    });
  }

  return should;
};

const buildSearchFilter = (query: VectorSearchQuery): Record<string, unknown> => {
  const must: Array<Record<string, unknown>> = [
    {
      key: 'embeddingSchemaVersion',
      match: { value: query.schemaVersion ?? ACTIVE_EMBEDDING_SCHEMA_VERSION },
    },
  ];

  if (query.retrievalProfile) {
    must.push({
      key: 'retrievalProfile',
      match: { value: query.retrievalProfile },
    });
  }

  if (query.sourceTypes && query.sourceTypes.length > 0) {
    must.push({
      key: 'sourceType',
      match:
        query.sourceTypes.length === 1
          ? { value: query.sourceTypes[0] }
          : { any: query.sourceTypes },
    });
  }

  if (query.fileAssetId) {
    must.push({
      key: 'fileAssetId',
      match: { value: query.fileAssetId },
    });
  }

  if (query.enforceEmailMatch && typeof query.requesterEmail === 'string' && query.requesterEmail) {
    must.push({
      key: 'referenceEmails',
      match: { any: [query.requesterEmail.trim().toLowerCase()] },
    });
  }

  const isFileDoctypeRequested =
    !query.sourceTypes ||
    query.sourceTypes.length === 0 ||
    query.sourceTypes.includes('file_document');

  if (isFileDoctypeRequested && query.requesterAiRole) {
    must.push({
      should: [
        { is_empty: { key: 'allowedRoles' } },
        { key: 'allowedRoles', match: { any: [query.requesterAiRole] } },
        {
          key: 'sourceType',
          match: {
            any: [
              'zoho_lead',
              'zoho_contact',
              'zoho_account',
              'zoho_deal',
              'zoho_ticket',
              'chat_turn',
            ],
          },
        },
      ],
    });
  }

  return {
    should: buildScopeShouldClauses(query),
    must,
  };
};

export class QdrantAdapter implements VectorStoreAdapter {
  private readonly baseUrl = config.QDRANT_URL.replace(/\/$/, '');

  private readonly collection = config.QDRANT_RETRIEVAL_COLLECTION.trim()
    ? config.QDRANT_RETRIEVAL_COLLECTION
    : config.QDRANT_COLLECTION;

  private readonly apiKey = config.QDRANT_API_KEY;

  private readonly timeoutMs = config.QDRANT_TIMEOUT_MS;

  private readonly primaryVectorSize = resolvePrimaryTextVectorSize();

  private readonly multimodalVectorSize = resolveMultimodalVectorSize();

  private ensuringCollection: Promise<void> | null = null;
  private ensuringFilterIndexes: Promise<void> | null = null;

  private headers(contentType = true): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['api-key'] = this.apiKey;
    }
    return headers;
  }

  private async request<T>(input: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers: this.headers(input.body !== undefined),
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'vector_timeout'
          : 'vector_unavailable';
      throw new VectorStoreError(
        error instanceof Error ? error.message : 'Qdrant request failed',
        code,
      );
    }

    const raw = await response.text();
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        payload = raw;
      }
    }

    if (!response.ok) {
      throw new VectorStoreError(
        `Qdrant request failed (${response.status}): ${typeof payload === 'string' ? payload : raw}`,
        response.status === 504 || response.status === 408
          ? 'vector_timeout'
          : 'vector_unavailable',
      );
    }

    return payload as T;
  }

  private async ensureCollection(): Promise<void> {
    if (!this.ensuringCollection) {
      this.ensuringCollection = this.ensureCollectionInternal().finally(() => {
        this.ensuringCollection = null;
      });
    }
    return this.ensuringCollection;
  }

  private async ensureIndexes(): Promise<void> {
    if (!this.ensuringFilterIndexes) {
      this.ensuringFilterIndexes = this.ensureIndexesInternal().finally(() => {
        this.ensuringFilterIndexes = null;
      });
    }
    return this.ensuringFilterIndexes;
  }

  private async ensureCollectionInternal(): Promise<void> {
    try {
      await this.request({
        method: 'GET',
        path: `/collections/${encodeURIComponent(this.collection)}`,
      });
      return;
    } catch (error) {
      if (!isCollectionNotFoundError(error)) {
        throw error;
      }
    }

    await this.request({
      method: 'PUT',
      path: `/collections/${encodeURIComponent(this.collection)}`,
      body: {
        vectors: {
          [PRIMARY_TEXT_VECTOR_NAME]: {
            size: this.primaryVectorSize,
            distance: 'Cosine',
          },
          [MULTIMODAL_VECTOR_NAME]: {
            size: this.multimodalVectorSize,
            distance: 'Cosine',
          },
        },
      },
    });

    logger.info('qdrant.collection.created', {
      collection: this.collection,
      primaryVectorSize: this.primaryVectorSize,
      multimodalVectorSize: this.multimodalVectorSize,
    });
  }

  private async ensureIndexesInternal(): Promise<void> {
    const indexRequests: Array<{
      fieldName: string;
      fieldSchema:
        | 'keyword'
        | 'integer'
        | 'datetime'
        | {
            type: 'text';
            tokenizer?: 'multilingual' | 'word';
            lowercase?: boolean;
            min_token_len?: number;
          };
    }> = [
      { fieldName: 'companyId', fieldSchema: 'keyword' },
      { fieldName: 'documentKey', fieldSchema: 'keyword' },
      { fieldName: 'sourceType', fieldSchema: 'keyword' },
      { fieldName: 'sourceId', fieldSchema: 'keyword' },
      { fieldName: 'fileAssetId', fieldSchema: 'keyword' },
      { fieldName: 'visibility', fieldSchema: 'keyword' },
      { fieldName: 'ownerUserId', fieldSchema: 'keyword' },
      { fieldName: 'referenceEmails', fieldSchema: 'keyword' },
      { fieldName: 'conversationKey', fieldSchema: 'keyword' },
      { fieldName: 'allowedRoles', fieldSchema: 'keyword' },
      { fieldName: 'embeddingSchemaVersion', fieldSchema: 'keyword' },
      { fieldName: 'retrievalProfile', fieldSchema: 'keyword' },
      { fieldName: 'sourceUpdatedAt', fieldSchema: 'datetime' },
      { fieldName: 'chunkIndex', fieldSchema: 'integer' },
      {
        fieldName: 'chunkText',
        fieldSchema: {
          type: 'text',
          tokenizer: 'multilingual',
          lowercase: true,
          min_token_len: 2,
        },
      },
    ];

    for (const indexRequest of indexRequests) {
      try {
        await this.request({
          method: 'PUT',
          path: `/collections/${encodeURIComponent(this.collection)}/index?wait=true`,
          body: {
            field_name: indexRequest.fieldName,
            field_schema: indexRequest.fieldSchema,
          },
        });
      } catch (error) {
        if (isCollectionNotFoundError(error)) {
          return;
        }
        throw error;
      }
    }
  }

  async upsert(points: VectorPointUpsert[]): Promise<void> {
    if (points.length === 0) {
      return;
    }

    await this.ensureCollection();
    await this.ensureIndexes();

    const qdrantPoints: QdrantPoint[] = points.map((point) => ({
      id: point.id,
      vector: {
        [PRIMARY_TEXT_VECTOR_NAME]: point.denseVector,
        ...(point.multimodalVector ? { [MULTIMODAL_VECTOR_NAME]: point.multimodalVector } : {}),
      },
      payload: {
        companyId: point.companyId,
        documentKey: point.documentKey,
        sourceType: point.sourceType,
        sourceId: point.sourceId,
        chunkIndex: point.chunkIndex,
        contentHash: point.contentHash,
        visibility: point.visibility,
        ...(point.ownerUserId ? { ownerUserId: point.ownerUserId } : {}),
        ...(point.conversationKey ? { conversationKey: point.conversationKey } : {}),
        ...point.payload,
      },
    }));

    await this.request({
      method: 'PUT',
      path: `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      body: {
        points: qdrantPoints,
      },
    });
  }

  async upsertVectors(records: QdrantUpsertInput[]): Promise<void> {
    const points: VectorPointUpsert[] = records.map((record) => ({
      id: buildPointId(record),
      companyId: record.companyId,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      chunkIndex: record.chunkIndex,
      documentKey:
        record.documentKey ?? `${record.companyId}:${record.sourceType}:${record.sourceId}`,
      contentHash: record.contentHash,
      visibility: record.visibility ?? 'shared',
      ownerUserId: record.ownerUserId,
      conversationKey: record.conversationKey,
      payload: {
        ...record.payload,
        ...(Array.isArray(record.referenceEmails)
          ? { referenceEmails: record.referenceEmails }
          : {}),
        ...(record.connectionId ? { connectionId: record.connectionId } : {}),
        ...(record.fileAssetId ? { fileAssetId: record.fileAssetId } : {}),
        ...(Array.isArray(record.allowedRoles) ? { allowedRoles: record.allowedRoles } : {}),
        documentKey:
          record.documentKey ?? `${record.companyId}:${record.sourceType}:${record.sourceId}`,
        chunkText: record.content ?? record.payload.chunkText ?? record.payload.text,
        sourceUpdatedAt: record.sourceUpdatedAt ?? record.updatedAt,
        title: record.title,
        text: record.content ?? record.payload.text,
        embeddingSchemaVersion: record.embeddingSchemaVersion ?? ACTIVE_EMBEDDING_SCHEMA_VERSION,
        retrievalProfile: record.retrievalProfile,
      },
      denseVector: record.denseEmbedding,
      multimodalVector: record.multimodalEmbedding,
    }));

    await this.upsert(points);
  }

  async deleteBySource(input: VectorDeleteBySourceInput): Promise<void> {
    try {
      await this.request({
        method: 'POST',
        path: `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
        body: {
          filter: {
            must: [
              { key: 'companyId', match: { value: input.companyId } },
              { key: 'sourceType', match: { value: input.sourceType } },
              { key: 'sourceId', match: { value: input.sourceId } },
            ],
          },
        },
      });
    } catch (error) {
      if (isCollectionNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  async deleteVectorsBySource(input: {
    companyId: string;
    sourceType: VectorUpsertDTO['sourceType'];
    sourceId: string;
  }): Promise<void> {
    await this.deleteBySource(input);
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchGroup[]> {
    const filter = buildSearchFilter(query);
    const branchLimit = Math.max(
      query.limit,
      Math.min(50, Math.max(10, query.candidateLimit ?? Math.max(query.limit * 4, 24))),
    );
    const prefetch: Array<Record<string, unknown>> = [
      {
        query: query.denseVector,
        using: PRIMARY_TEXT_VECTOR_NAME,
        limit: branchLimit,
        filter,
      },
    ];

    if (query.lexicalQueryText?.trim()) {
      prefetch.push({
        query: query.lexicalQueryText.trim(),
        limit: branchLimit,
        filter,
      });
    }

    if (query.useMultimodal && query.queryMode && query.queryMode !== 'text') {
      prefetch.push({
        query: query.denseVector,
        using: MULTIMODAL_VECTOR_NAME,
        limit: branchLimit,
        filter,
      });
    }

    let payload: QdrantGroupsResponse;
    try {
      await this.ensureCollection();
      payload = await this.request<QdrantGroupsResponse>({
        method: 'POST',
        path: `/collections/${encodeURIComponent(this.collection)}/points/query/groups`,
        body: {
          prefetch,
          query: prefetch.length > 1 ? { fusion: query.fusion ?? 'dbsf' } : query.denseVector,
          using: prefetch.length > 1 ? undefined : PRIMARY_TEXT_VECTOR_NAME,
          filter: prefetch.length > 1 ? undefined : filter,
          group_by: query.groupByField ?? 'documentKey',
          group_size: Math.max(1, Math.min(10, query.groupSize ?? 3)),
          limit: Math.max(1, Math.min(25, query.limit)),
          with_payload: true,
        },
      });
    } catch (error) {
      if (isCollectionNotFoundError(error)) {
        await this.ensureCollection();
        await this.ensureIndexes();
        return [];
      }
      if (isMissingPayloadIndexError(error)) {
        await this.ensureIndexes();
        return this.search(query);
      }
      throw error;
    }

    await this.ensureIndexes();

    const groups = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray(payload.result?.groups)
        ? payload.result.groups
        : [];

    return groups.map((group) => ({
      groupValue: String(group.id ?? ''),
      hits: (group.hits ?? []).map(
        (item): VectorSearchResult => ({
          id: String(item.id),
          score: item.score,
          sourceType:
            (item.payload?.sourceType as VectorSearchResult['sourceType']) ?? 'zoho_contact',
          sourceId: String(item.payload?.sourceId ?? ''),
          chunkIndex: Number(item.payload?.chunkIndex ?? 0),
          documentKey:
            typeof item.payload?.documentKey === 'string' ? item.payload.documentKey : undefined,
          visibility: (item.payload?.visibility as VectorSearchResult['visibility']) ?? 'shared',
          ownerUserId:
            typeof item.payload?.ownerUserId === 'string' ? item.payload.ownerUserId : undefined,
          conversationKey:
            typeof item.payload?.conversationKey === 'string'
              ? item.payload.conversationKey
              : undefined,
          allowedRoles: Array.isArray(item.payload?.allowedRoles)
            ? (item.payload.allowedRoles as string[])
            : undefined,
          payload: (item.payload ?? {}) as Record<string, unknown>,
        }),
      ),
    }));
  }

  async countByCompany(companyId: string): Promise<number> {
    let payload: QdrantCountResponse;
    try {
      await this.ensureIndexes();
      payload = await this.request<QdrantCountResponse>({
        method: 'POST',
        path: `/collections/${encodeURIComponent(this.collection)}/points/count`,
        body: {
          exact: true,
          filter: {
            must: [
              { key: 'companyId', match: { value: companyId } },
              { key: 'embeddingSchemaVersion', match: { value: ACTIVE_EMBEDDING_SCHEMA_VERSION } },
            ],
          },
        },
      });
    } catch (error) {
      if (isCollectionNotFoundError(error)) {
        return 0;
      }
      if (isMissingPayloadIndexError(error)) {
        await this.ensureIndexes();
        return this.countByCompany(companyId);
      }
      throw error;
    }

    return Number(payload.result?.count ?? 0);
  }

  async health(): Promise<VectorStoreHealth> {
    const startedAt = Date.now();
    try {
      await this.request({
        method: 'GET',
        path: `/collections/${encodeURIComponent(this.collection)}`,
      });
      await this.ensureIndexes();
      return {
        ok: true,
        backend: 'qdrant',
        collection: this.collection,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        backend: 'qdrant',
        collection: this.collection,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'qdrant health check failed',
      };
    }
  }
}

export const qdrantAdapter = new QdrantAdapter();
