/**
 * QdrantAdapter — full Qdrant vector store client.
 *
 * Features ported from the old backend (no LangChain, no global config):
 *   • Deterministic point IDs (SHA-1 → UUID v5-style)
 *   • Named multi-vectors: dense_text_v2 + dense_mm_v1
 *   • Grouped search (query/groups API) with multi-vector prefetch + DBSF/RRF fusion
 *   • Visibility/scope filter (public | shared | personal)
 *   • Payload filters: embeddingSchemaVersion, retrievalProfile, sourceTypes, fileAssetId,
 *     conversationKey, enforceEmailMatch, dateFrom/dateTo, allowedRoles
 *   • Collection auto-provisioning (PUT if GET → 404)
 *   • Payload index auto-provisioning (PUT index on first upsert/search)
 *   • Retry-on-missing-index for upsert, delete, and search
 *   • Timeout via AbortSignal.timeout (configurable via QDRANT_TIMEOUT_MS)
 *   • Health check with latency
 */

import { createHash } from 'crypto';
import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import type {
  VectorDeleteBySourceInput,
  VectorPointUpsert,
  VectorSearchGroup,
  VectorSearchQuery,
  VectorSearchResult,
  VectorStoreAdapter,
  VectorStoreHealth,
  VectorUpsertInput,
} from './types';
import {
  ACTIVE_EMBEDDING_SCHEMA_VERSION,
  MULTIMODAL_VECTOR_NAME,
  PRIMARY_TEXT_VECTOR_NAME,
} from './types';

// ─── Internal error ────────────────────────────────────────────────────────────

class VectorStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'vector_timeout' | 'vector_unavailable',
  ) {
    super(message);
    this.name = 'VectorStoreError';
  }
}

const isNotFoundError = (e: unknown): boolean =>
  e instanceof VectorStoreError && e.message.includes('(404)');

const isMissingIndexError = (e: unknown): boolean =>
  e instanceof VectorStoreError && e.message.includes('Index required but not found');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a deterministic UUID v5-style point ID from the compound key.
 * Same algorithm as old backend so existing indexed points remain addressable.
 */
function buildPointId(p: {
  companyId: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
}): string {
  const seed = createHash('sha1')
    .update(`${p.companyId}|${p.sourceType}|${p.sourceId}|${p.chunkIndex}`)
    .digest('hex')
    .slice(0, 32)
    .padEnd(32, '0');

  const chars = seed.split('');
  chars[12] = '5';
  const variant = parseInt(chars[16] ?? '0', 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const n = chars.join('');
  return [n.slice(0, 8), n.slice(8, 12), n.slice(12, 16), n.slice(16, 20), n.slice(20, 32)].join('-');
}

// ─── Filter builders ──────────────────────────────────────────────────────────

type FilterClause = Record<string, unknown>;

function buildScopeShould(q: VectorSearchQuery): FilterClause[] {
  const should: FilterClause[] = [];
  const includePublic   = q.includePublic   ?? true;
  const includeShared   = q.includeShared   ?? true;
  const includePersonal = (q.includePersonal ?? true) && Boolean(q.requesterUserId);

  if (includePublic) {
    should.push({ must: [{ key: 'visibility', match: { value: 'public' } }] });
  }
  if (includeShared) {
    should.push({
      must: [
        { key: 'companyId', match: { value: q.companyId } },
        { key: 'visibility', match: { value: 'shared' } },
      ],
    });
  }
  if (includePersonal && q.requesterUserId) {
    should.push({
      must: [
        { key: 'companyId', match: { value: q.companyId } },
        { key: 'visibility', match: { value: 'personal' } },
        { key: 'ownerUserId', match: { value: q.requesterUserId } },
      ],
    });
  }
  if (should.length === 0) {
    should.push({ must: [{ key: 'companyId', match: { value: q.companyId } }] });
  }
  return should;
}

function buildSearchFilter(q: VectorSearchQuery): FilterClause {
  const must: FilterClause[] = [
    {
      key: 'embeddingSchemaVersion',
      match: { value: q.schemaVersion ?? ACTIVE_EMBEDDING_SCHEMA_VERSION },
    },
  ];

  if (q.retrievalProfile) {
    must.push({ key: 'retrievalProfile', match: { value: q.retrievalProfile } });
  }
  if (q.sourceTypes && q.sourceTypes.length > 0) {
    must.push({
      key: 'sourceType',
      match: q.sourceTypes.length === 1
        ? { value: q.sourceTypes[0] }
        : { any: q.sourceTypes },
    });
  }
  if (q.fileAssetId) {
    must.push({ key: 'fileAssetId', match: { value: q.fileAssetId } });
  }
  if (q.conversationKey) {
    must.push({ key: 'conversationKey', match: { value: q.conversationKey } });
  }
  if (q.enforceEmailMatch && q.requesterEmail) {
    must.push({
      key: 'referenceEmails',
      match: { any: [q.requesterEmail.trim().toLowerCase()] },
    });
  }
  if (q.dateFrom || q.dateTo) {
    const range: Record<string, unknown> = {};
    if (q.dateFrom) range['gte'] = q.dateFrom;
    if (q.dateTo)   range['lte'] = q.dateTo;
    must.push({ key: 'sourceUpdatedAt', range });
  }

  // Role-based access: only applies when file_document is in scope
  const isFileScopeRequested =
    !q.sourceTypes || q.sourceTypes.length === 0 || q.sourceTypes.includes('file_document');
  if (isFileScopeRequested && q.requesterAiRole) {
    must.push({
      should: [
        { is_empty: { key: 'allowedRoles' } },
        { key: 'allowedRoles', match: { any: [q.requesterAiRole] } },
        {
          key: 'sourceType',
          match: {
            any: ['zoho_lead', 'zoho_contact', 'zoho_account', 'zoho_deal', 'zoho_ticket', 'chat_turn'],
          },
        },
      ],
    });
  }

  return { should: buildScopeShould(q), must };
}

// ─── Payload index definitions ─────────────────────────────────────────────────

type FieldSchema =
  | 'keyword'
  | 'integer'
  | 'datetime'
  | { type: 'text'; tokenizer?: 'multilingual' | 'word'; lowercase?: boolean; min_token_len?: number };

const PAYLOAD_INDEXES: Array<{ fieldName: string; fieldSchema: FieldSchema }> = [
  { fieldName: 'companyId',              fieldSchema: 'keyword' },
  { fieldName: 'documentKey',            fieldSchema: 'keyword' },
  { fieldName: 'sourceType',             fieldSchema: 'keyword' },
  { fieldName: 'sourceId',               fieldSchema: 'keyword' },
  { fieldName: 'fileAssetId',            fieldSchema: 'keyword' },
  { fieldName: 'visibility',             fieldSchema: 'keyword' },
  { fieldName: 'ownerUserId',            fieldSchema: 'keyword' },
  { fieldName: 'referenceEmails',        fieldSchema: 'keyword' },
  { fieldName: 'conversationKey',        fieldSchema: 'keyword' },
  { fieldName: 'allowedRoles',           fieldSchema: 'keyword' },
  { fieldName: 'embeddingSchemaVersion', fieldSchema: 'keyword' },
  { fieldName: 'retrievalProfile',       fieldSchema: 'keyword' },
  { fieldName: 'sourceUpdatedAt',        fieldSchema: 'datetime' },
  { fieldName: 'chunkIndex',             fieldSchema: 'integer' },
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

// ─── Qdrant response shapes ────────────────────────────────────────────────────

type QdrantCountResponse = { result?: { count?: number } };

type QdrantGroupHit = {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
};

type QdrantGroupsResponse = {
  result?:
    | { groups?: Array<{ id?: string | number; hits?: QdrantGroupHit[] }> }
    | Array<{ id?: string | number; hits?: QdrantGroupHit[] }>;
};

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class QdrantAdapter implements VectorStoreAdapter {
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly primaryVectorSize: number;
  private readonly multimodalVectorSize = 3072;
  private readonly logger: Logger;

  /** In-flight collection creation promise (deduplicates concurrent calls). */
  private ensuringCollection: Promise<void> | null = null;
  /** In-flight index creation promise (deduplicates concurrent calls). */
  private ensuringIndexes: Promise<void> | null = null;

  constructor(opts: {
    env: TypedEnv;
    primaryVectorDimension: number;
    logger: Logger;
  }) {
    this.baseUrl    = opts.env.QDRANT_URL.replace(/\/$/, '');
    this.collection = (opts.env.QDRANT_RETRIEVAL_COLLECTION?.trim()
      ? opts.env.QDRANT_RETRIEVAL_COLLECTION
      : opts.env.QDRANT_COLLECTION
    ).trim();
    this.apiKey     = opts.env.QDRANT_API_KEY;
    this.timeoutMs  = opts.env.QDRANT_TIMEOUT_MS;
    this.primaryVectorSize = opts.primaryVectorDimension;
    this.logger     = opts.logger.child({ adapter: 'qdrant', collection: this.collection });
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private headers(withBody = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (withBody) h['Content-Type'] = 'application/json';
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  private async request<T>(opts: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
  }): Promise<T> {
    let res: Response;
    try {
      const fetchInit: RequestInit = {
        method:  opts.method,
        headers: this.headers(opts.body !== undefined),
        signal:  AbortSignal.timeout(this.timeoutMs),
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      };
      res = await fetch(`${this.baseUrl}${opts.path}`, fetchInit);
    } catch (e) {
      const code =
        e instanceof Error && e.name === 'TimeoutError' ? 'vector_timeout' : 'vector_unavailable';
      throw new VectorStoreError(
        e instanceof Error ? e.message : 'Qdrant fetch failed',
        code,
      );
    }

    const raw = await res.text();
    let payload: unknown;
    try   { payload = raw ? (JSON.parse(raw) as unknown) : {}; }
    catch { payload = raw; }

    if (!res.ok) {
      throw new VectorStoreError(
        `Qdrant request failed (${res.status}): ${typeof payload === 'string' ? payload : raw}`,
        res.status === 504 || res.status === 408 ? 'vector_timeout' : 'vector_unavailable',
      );
    }

    return payload as T;
  }

  // ── Collection provisioning ───────────────────────────────────────────────

  private ensureCollection(): Promise<void> {
    if (!this.ensuringCollection) {
      this.ensuringCollection = this.doEnsureCollection().finally(() => {
        this.ensuringCollection = null;
      });
    }
    return this.ensuringCollection;
  }

  private ensureIndexes(): Promise<void> {
    if (!this.ensuringIndexes) {
      this.ensuringIndexes = this.doEnsureIndexes().finally(() => {
        this.ensuringIndexes = null;
      });
    }
    return this.ensuringIndexes;
  }

  private async doEnsureCollection(): Promise<void> {
    try {
      await this.request({ method: 'GET', path: `/collections/${encodeURIComponent(this.collection)}` });
      return; // already exists
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }

    // Create with named multi-vectors
    await this.request({
      method: 'PUT',
      path:   `/collections/${encodeURIComponent(this.collection)}`,
      body: {
        vectors: {
          [PRIMARY_TEXT_VECTOR_NAME]: { size: this.primaryVectorSize, distance: 'Cosine' },
          [MULTIMODAL_VECTOR_NAME]:   { size: this.multimodalVectorSize, distance: 'Cosine' },
        },
      },
    });

    this.logger.info('qdrant.collection.created', {
      collection: this.collection,
      primaryVectorSize: this.primaryVectorSize,
      multimodalVectorSize: this.multimodalVectorSize,
    });
  }

  private async doEnsureIndexes(): Promise<void> {
    for (const { fieldName, fieldSchema } of PAYLOAD_INDEXES) {
      try {
        await this.request({
          method: 'PUT',
          path:   `/collections/${encodeURIComponent(this.collection)}/index?wait=true`,
          body: {
            field_name:   fieldName,
            field_schema: fieldSchema,
          },
        });
      } catch (e) {
        if (isNotFoundError(e)) return; // collection not yet created — skip
        throw e;
      }
    }
  }

  // ── VectorStoreAdapter interface ──────────────────────────────────────────

  async upsert(points: VectorPointUpsert[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureCollection();
    await this.ensureIndexes();

    const qdrantPoints = points.map(p => ({
      id: p.id,
      vector: {
        [PRIMARY_TEXT_VECTOR_NAME]: p.denseVector,
        ...(p.multimodalVector ? { [MULTIMODAL_VECTOR_NAME]: p.multimodalVector } : {}),
      },
      payload: {
        companyId:       p.companyId,
        documentKey:     p.documentKey,
        sourceType:      p.sourceType,
        sourceId:        p.sourceId,
        chunkIndex:      p.chunkIndex,
        contentHash:     p.contentHash,
        visibility:      p.visibility,
        ...(p.ownerUserId      ? { ownerUserId: p.ownerUserId }           : {}),
        ...(p.conversationKey  ? { conversationKey: p.conversationKey }   : {}),
        ...p.payload,
      },
    }));

    try {
      await this.request({
        method: 'PUT',
        path:   `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
        body:   { points: qdrantPoints },
      });
    } catch (e) {
      if (!isMissingIndexError(e)) throw e;
      this.logger.warn('qdrant.upsert.retry_missing_index', { count: points.length });
      await this.ensureIndexes();
      await this.request({
        method: 'PUT',
        path:   `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
        body:   { points: qdrantPoints },
      });
    }
  }

  async upsertVectors(records: VectorUpsertInput[]): Promise<void> {
    if (records.length === 0) return;
    const points: VectorPointUpsert[] = records.map(r => ({
      id:             buildPointId(r),
      companyId:      r.companyId,
      sourceType:     r.sourceType,
      sourceId:       r.sourceId,
      chunkIndex:     r.chunkIndex,
      documentKey:    r.documentKey ?? `${r.companyId}:${r.sourceType}:${r.sourceId}`,
      contentHash:    r.contentHash,
      visibility:     r.visibility ?? 'shared',
      ...(r.ownerUserId      ? { ownerUserId:      r.ownerUserId      } : {}),
      ...(r.conversationKey  ? { conversationKey:  r.conversationKey  } : {}),
      denseVector:    r.denseEmbedding,
      ...(r.multimodalEmbedding ? { multimodalVector: r.multimodalEmbedding } : {}),
      payload: {
        ...r.payload,
        documentKey:    r.documentKey ?? `${r.companyId}:${r.sourceType}:${r.sourceId}`,
        chunkText:      r.content ?? (r.payload['chunkText'] as string | undefined) ?? (r.payload['text'] as string | undefined),
        title:          r.title,
        text:           r.content ?? (r.payload['text'] as string | undefined),
        sourceUpdatedAt: r.sourceUpdatedAt,
        embeddingSchemaVersion: r.embeddingSchemaVersion ?? ACTIVE_EMBEDDING_SCHEMA_VERSION,
        retrievalProfile: r.retrievalProfile,
        ...(r.connectionId ? { connectionId: r.connectionId } : {}),
        ...(r.fileAssetId  ? { fileAssetId:  r.fileAssetId  } : {}),
        ...(Array.isArray(r.referenceEmails) ? { referenceEmails: r.referenceEmails } : {}),
        ...(Array.isArray(r.allowedRoles)    ? { allowedRoles:    r.allowedRoles    } : {}),
      },
    }));
    await this.upsert(points);
  }

  async deleteBySource(input: VectorDeleteBySourceInput): Promise<void> {
    const filter = {
      must: [
        { key: 'companyId',  match: { value: input.companyId  } },
        { key: 'sourceType', match: { value: input.sourceType } },
        { key: 'sourceId',   match: { value: input.sourceId   } },
      ],
    };

    try {
      await this.ensureCollection();
      await this.ensureIndexes();
      await this.request({
        method: 'POST',
        path:   `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
        body:   { filter },
      });
    } catch (e) {
      if (isNotFoundError(e))    return;
      if (!isMissingIndexError(e)) throw e;
      this.logger.warn('qdrant.delete.retry_missing_index', { ...input });
      await this.ensureIndexes();
      await this.request({
        method: 'POST',
        path:   `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
        body:   { filter },
      });
    }
  }

  async updateVisibilityForFileAsset(input: {
    companyId: string;
    fileAssetId: string;
    visibility: 'personal' | 'shared' | 'public';
  }): Promise<void> {
    const filter = {
      must: [
        { key: 'companyId',   match: { value: input.companyId   } },
        { key: 'fileAssetId', match: { value: input.fileAssetId } },
      ],
    };
    await this.ensureCollection();
    await this.ensureIndexes();
    await this.request({
      method: 'POST',
      path:   `/collections/${encodeURIComponent(this.collection)}/points/payload?wait=true`,
      body:   { payload: { visibility: input.visibility }, filter },
    });
  }

  async deleteOwnedChatTurns(input: { companyId: string; ownerUserId: string }): Promise<void> {
    const filter = {
      must: [
        { key: 'companyId',   match: { value: input.companyId  } },
        { key: 'sourceType',  match: { value: 'chat_turn'       } },
        { key: 'ownerUserId', match: { value: input.ownerUserId } },
      ],
    };
    try {
      await this.ensureIndexes();
      await this.request({
        method: 'POST',
        path:   `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
        body:   { filter },
      });
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.ensureCollection();
      await this.ensureIndexes();
    }
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchGroup[]> {
    const filter      = buildSearchFilter(query);
    const branchLimit = Math.max(
      query.limit,
      Math.min(50, Math.max(10, query.candidateLimit ?? Math.max(query.limit * 4, 24))),
    );

    const prefetch: FilterClause[] = [
      {
        query:  query.denseVector,
        using:  PRIMARY_TEXT_VECTOR_NAME,
        limit:  branchLimit,
        filter,
        ...(typeof query.scoreThreshold === 'number' ? { score_threshold: query.scoreThreshold } : {}),
      },
    ];

    if (query.useMultimodal && query.queryMode && query.queryMode !== 'text') {
      prefetch.push({
        query:  query.denseVector,
        using:  MULTIMODAL_VECTOR_NAME,
        limit:  branchLimit,
        filter,
      });
    }

    const isMultiBranch = prefetch.length > 1;

    let payload: QdrantGroupsResponse;
    try {
      await this.ensureCollection();
      payload = await this.request<QdrantGroupsResponse>({
        method: 'POST',
        path:   `/collections/${encodeURIComponent(this.collection)}/points/query/groups`,
        body: {
          prefetch,
          query:  isMultiBranch ? { fusion: query.fusion ?? 'dbsf' } : query.denseVector,
          using:  isMultiBranch ? undefined : PRIMARY_TEXT_VECTOR_NAME,
          filter: isMultiBranch ? undefined : filter,
          ...(
            !isMultiBranch && typeof query.scoreThreshold === 'number'
              ? { score_threshold: query.scoreThreshold }
              : {}
          ),
          group_by:   query.groupByField ?? 'documentKey',
          group_size: Math.max(1, Math.min(10, query.groupSize ?? 3)),
          limit:      Math.max(1, Math.min(25, query.limit)),
          with_payload: true,
        },
      });
    } catch (e) {
      if (isNotFoundError(e)) {
        await this.ensureCollection();
        await this.ensureIndexes();
        return [];
      }
      if (isMissingIndexError(e)) {
        await this.ensureIndexes();
        return this.search(query);
      }
      throw e;
    }

    await this.ensureIndexes();

    const groups = Array.isArray(payload.result)
      ? payload.result
      : Array.isArray((payload.result as { groups?: unknown[] } | undefined)?.groups)
        ? ((payload.result as { groups: Array<{ id?: string | number; hits?: QdrantGroupHit[] }> }).groups)
        : [];

    return groups.map(group => ({
      groupValue: String(group.id ?? ''),
      hits: (group.hits ?? []).map((item): VectorSearchResult => {
        const p = item.payload ?? {};
        const docKey     = typeof p['documentKey']    === 'string' ? p['documentKey']    : undefined;
        const ownerId    = typeof p['ownerUserId']    === 'string' ? p['ownerUserId']    : undefined;
        const convKey    = typeof p['conversationKey'] === 'string' ? p['conversationKey'] : undefined;
        const allRoles   = Array.isArray(p['allowedRoles']) ? (p['allowedRoles'] as string[]) : undefined;
        return {
          id:         String(item.id),
          score:      item.score,
          sourceType: (p['sourceType'] as VectorSearchResult['sourceType']) ?? 'zoho_contact',
          sourceId:   String(p['sourceId'] ?? ''),
          chunkIndex: Number(p['chunkIndex'] ?? 0),
          visibility: (p['visibility'] as VectorSearchResult['visibility']) ?? 'shared',
          payload:    p as Record<string, unknown>,
          ...(docKey   ? { documentKey:    docKey   } : {}),
          ...(ownerId  ? { ownerUserId:    ownerId  } : {}),
          ...(convKey  ? { conversationKey: convKey } : {}),
          ...(allRoles ? { allowedRoles:   allRoles } : {}),
        };
      }),
    }));
  }

  async countByCompany(companyId: string): Promise<number> {
    let payload: QdrantCountResponse;
    try {
      await this.ensureIndexes();
      payload = await this.request<QdrantCountResponse>({
        method: 'POST',
        path:   `/collections/${encodeURIComponent(this.collection)}/points/count`,
        body: {
          exact: true,
          filter: {
            must: [
              { key: 'companyId',              match: { value: companyId } },
              { key: 'embeddingSchemaVersion', match: { value: ACTIVE_EMBEDDING_SCHEMA_VERSION } },
            ],
          },
        },
      });
    } catch (e) {
      if (isNotFoundError(e)) return 0;
      if (isMissingIndexError(e)) {
        await this.ensureIndexes();
        return this.countByCompany(companyId);
      }
      throw e;
    }
    return Number(payload.result?.count ?? 0);
  }

  async health(): Promise<VectorStoreHealth> {
    const startedAt = Date.now();
    try {
      await this.request({ method: 'GET', path: `/collections/${encodeURIComponent(this.collection)}` });
      await this.ensureIndexes();
      return {
        ok: true,
        backend: 'qdrant',
        collection: this.collection,
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        ok: false,
        backend: 'qdrant',
        collection: this.collection,
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : 'qdrant health check failed',
      };
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a QdrantAdapter wired to the correct vector dimension for the
 * configured embedding provider.
 */
export function createQdrantAdapter(opts: {
  env: TypedEnv;
  /** Dimension of the primary text embedding vectors. */
  primaryVectorDimension: number;
  logger: Logger;
}): QdrantAdapter {
  return new QdrantAdapter(opts);
}

// ─── Re-export types ──────────────────────────────────────────────────────────

export type {
  VectorStoreAdapter,
  VectorPointUpsert,
  VectorUpsertInput,
  VectorSearchQuery,
  VectorSearchResult,
  VectorSearchGroup,
  VectorDeleteBySourceInput,
  VectorStoreHealth,
  VectorSourceType,
  VectorVisibility,
  RetrievalProfile,
  QueryMode,
} from './types';
