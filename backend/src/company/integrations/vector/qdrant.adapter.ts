import { createHash } from 'crypto';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import type { VectorUpsertDTO } from '../../contracts';
import type {
  VectorDeleteBySourceInput,
  VectorPointUpsert,
  VectorSearchQuery,
  VectorSearchResult,
  VectorStoreAdapter,
  VectorStoreHealth,
} from './vector-store.adapter';

export type QdrantUpsertInput = VectorUpsertDTO & {
  connectionId: string;
  embedding: number[];
};

type QdrantPoint = {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
};

type QdrantCountResponse = {
  result?: {
    count?: number;
  };
};

type QdrantSearchResponse = {
  result?: Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
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

const buildPointId = (point: {
  companyId: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
}): string =>
  createHash('sha1')
    .update(`${point.companyId}|${point.sourceType}|${point.sourceId}|${point.chunkIndex}`)
    .digest('hex');

export class QdrantAdapter implements VectorStoreAdapter {
  private readonly baseUrl = config.QDRANT_URL.replace(/\/$/, '');

  private readonly collection = config.QDRANT_COLLECTION;

  private readonly apiKey = config.QDRANT_API_KEY;

  private readonly timeoutMs = config.QDRANT_TIMEOUT_MS;

  private ensuringCollection: Promise<void> | null = null;

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
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'vector_timeout' : 'vector_unavailable';
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
        response.status === 504 || response.status === 408 ? 'vector_timeout' : 'vector_unavailable',
      );
    }

    return payload as T;
  }

  private async ensureCollection(vectorSize: number): Promise<void> {
    if (!this.ensuringCollection) {
      this.ensuringCollection = this.ensureCollectionInternal(vectorSize).finally(() => {
        this.ensuringCollection = null;
      });
    }

    return this.ensuringCollection;
  }

  private async ensureCollectionInternal(vectorSize: number): Promise<void> {
    try {
      await this.request({
        method: 'GET',
        path: `/collections/${encodeURIComponent(this.collection)}`,
      });
      return;
    } catch (error) {
      if (!(error instanceof VectorStoreError) || !error.message.includes('(404)')) {
        throw error;
      }
    }

    await this.request({
      method: 'PUT',
      path: `/collections/${encodeURIComponent(this.collection)}`,
      body: {
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      },
    });

    logger.info('qdrant.collection.created', {
      collection: this.collection,
      vectorSize,
    });
  }

  async upsert(points: VectorPointUpsert[]): Promise<void> {
    if (points.length === 0) {
      return;
    }

    await this.ensureCollection(points[0].vector.length);

    const qdrantPoints: QdrantPoint[] = points.map((point) => ({
      id: point.id,
      vector: point.vector,
      payload: {
        companyId: point.companyId,
        sourceType: point.sourceType,
        sourceId: point.sourceId,
        chunkIndex: point.chunkIndex,
        contentHash: point.contentHash,
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
      contentHash: record.contentHash,
      payload: {
        ...record.payload,
        connectionId: record.connectionId,
      },
      vector: record.embedding,
    }));

    await this.upsert(points);
  }

  async deleteBySource(input: VectorDeleteBySourceInput): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      body: {
        filter: {
          must: [
            {
              key: 'companyId',
              match: { value: input.companyId },
            },
            {
              key: 'sourceType',
              match: { value: input.sourceType },
            },
            {
              key: 'sourceId',
              match: { value: input.sourceId },
            },
          ],
        },
      },
    });
  }

  async deleteVectorsBySource(input: {
    companyId: string;
    sourceType: VectorUpsertDTO['sourceType'];
    sourceId: string;
  }): Promise<void> {
    await this.deleteBySource({
      companyId: input.companyId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const payload = await this.request<QdrantSearchResponse>({
      method: 'POST',
      path: `/collections/${encodeURIComponent(this.collection)}/points/search`,
      body: {
        vector: query.vector,
        limit: Math.max(1, Math.min(20, query.limit)),
        with_payload: true,
        filter: {
          must: [
            {
              key: 'companyId',
              match: {
                value: query.companyId,
              },
            },
          ],
        },
      },
    });

    return (payload.result ?? []).map((item) => ({
      id: String(item.id),
      score: item.score,
      sourceType: (item.payload?.sourceType as VectorSearchResult['sourceType']) ?? 'zoho_contact',
      sourceId: String(item.payload?.sourceId ?? ''),
      chunkIndex: Number(item.payload?.chunkIndex ?? 0),
      payload: (item.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async countByCompany(companyId: string): Promise<number> {
    const payload = await this.request<QdrantCountResponse>({
      method: 'POST',
      path: `/collections/${encodeURIComponent(this.collection)}/points/count`,
      body: {
        exact: true,
        filter: {
          must: [
            {
              key: 'companyId',
              match: {
                value: companyId,
              },
            },
          ],
        },
      },
    });

    return Number(payload.result?.count ?? 0);
  }

  async health(): Promise<VectorStoreHealth> {
    const startedAt = Date.now();
    try {
      await this.request({
        method: 'GET',
        path: `/collections/${encodeURIComponent(this.collection)}`,
      });
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
