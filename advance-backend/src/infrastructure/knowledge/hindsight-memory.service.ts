import { createHash } from 'node:crypto';
import {
  HindsightClient,
  type Budget,
  type MemoryItemInput,
  type RecallResponse,
} from '@vectorize-io/hindsight-client';
import type {
  MemoryRecallDepartment,
  MemoryRecallFact,
  MemoryRecallResult,
  MemoryRecallScopeStatus,
  MemoryScope,
  MemoryService,
} from '../../application/knowledge/semantic-memory.port';
import type {
  KnowledgeDocumentChunkInput,
  KnowledgeDocumentSemanticCandidate,
  KnowledgeDocumentSemanticIndex,
} from '../../application/knowledge/knowledge-document.port';
import type { Logger } from '../../shared/logger';

const PERSONAL_SNAPSHOT_QUERY = [
  'durable user preferences',
  'communication style',
  'stable workflow expectations',
  'corrections and recurring choices',
].join(', ');

export interface HindsightRecallEntry {
  readonly id: string;
  readonly text: string;
  readonly score?: number;
  readonly createdAt?: string;
  readonly metadata?: Record<string, string>;
}

export interface HindsightMemoryClient {
  ensureBank(bankId: string, options: {
    signal: AbortSignal;
  }): Promise<void>;

  retainBatch(bankId: string, items: readonly MemoryItemInput[], options: {
    signal: AbortSignal;
  }): Promise<void>;

  recall(bankId: string, query: string, options: {
    maxTokens: number;
    budget: Budget;
    tags?: readonly string[];
    tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact';
    signal: AbortSignal;
  }): Promise<HindsightRecallEntry[]>;

  deleteDocument(bankId: string, documentId: string, options: {
    signal: AbortSignal;
  }): Promise<void>;

}

export interface HindsightMemoryServiceDeps {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly maxResults: number;
  readonly recallMaxTokens: number;
  readonly recallBudget: Budget;
  readonly requestTimeoutMs: number;
  /** Prevent one multi-department user from creating an unbounded recall burst. */
  readonly recallConcurrency: number;
  readonly logger: Logger;
  readonly client?: HindsightMemoryClient;
}

interface ScopedBank {
  readonly bankId: string;
  readonly scope: MemoryScope;
  readonly label: string;
  readonly departmentName?: string;
}

interface RankedCandidate {
  readonly scope: 'personal' | 'department' | 'company';
  readonly text: string;
  readonly score: number;
  readonly departmentName?: string;
  readonly preferenceRank: number;
  readonly resourceId?: string;
}

export class HindsightMemoryService implements MemoryService, KnowledgeDocumentSemanticIndex {
  private readonly client: HindsightMemoryClient;

  constructor(private readonly deps: HindsightMemoryServiceDeps) {
    this.client = deps.client ?? new SdkHindsightMemoryClient({
      baseUrl: deps.baseUrl,
      ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    });
  }

  async searchForRecall(params: {
    query: string;
    userId: string;
    companyId: string;
    departments: readonly MemoryRecallDepartment[];
    departmentPreferences?: readonly string[];
    limit: number;
    maxFactChars: number;
    maxTotalChars: number;
  }): Promise<MemoryRecallResult> {
    const banks = this.recallBanks(params);
    const perScopeLimit = Math.min(this.deps.maxResults, params.limit);
    const settled = await mapSettledBounded(
      banks,
      this.deps.recallConcurrency,
      async bank => ({
        ...bank,
        entries: await this.recallBank(bank.bankId, params.query, perScopeLimit),
      }),
    );

    const coverage: {
      personal: MemoryRecallScopeStatus;
      departments: { searched: number; failed: number };
      company: MemoryRecallScopeStatus;
    } = {
      personal: 'failed',
      departments: { searched: 0, failed: 0 },
      company: 'failed',
    };
    const succeeded: Array<ScopedBank & { entries: HindsightRecallEntry[] }> = [];
    for (let index = 0; index < settled.length; index++) {
      const bank = banks[index]!;
      const result = settled[index]!;
      if (result.status === 'fulfilled') {
        if (bank.scope === 'personal') coverage.personal = 'searched';
        if (bank.scope === 'department') coverage.departments.searched++;
        if (bank.scope === 'company') coverage.company = 'searched';
        succeeded.push(result.value);
      } else {
        if (bank.scope === 'department') coverage.departments.failed++;
        this.deps.logger.warn('hindsight.recall.scope_failed', {
          scope: bank.scope,
          error: errorMessage(result.reason),
        });
      }
    }

    const preferenceRank = new Map(
      (params.departmentPreferences ?? []).map((name, index) => [normalizeDepartmentName(name), index]),
    );
    const candidates = succeeded.flatMap(group => group.entries.flatMap(entry => {
      const resourceId = projectedResourceId(entry);
      // Metadata-free entries belong to the retired pre-knowledge-core memory
      // path. They may remain in Hindsight until operational cleanup, but they
      // are not canonical and must never participate in recall.
      if (!resourceId) return [];
      return [{
        scope: group.scope,
        text: entry.text.trim(),
        score: entry.score ?? 0,
        ...(group.departmentName ? { departmentName: group.departmentName } : {}),
        preferenceRank: group.departmentName === undefined
          ? Number.MAX_SAFE_INTEGER
          : preferenceRank.get(normalizeDepartmentName(group.departmentName)) ?? Number.MAX_SAFE_INTEGER,
        resourceId,
      }];
    }));
    const facts = selectBoundedFacts(candidates, params);

    return {
      facts,
      coverage,
      status: succeeded.length === banks.length
        ? 'available'
        : succeeded.length > 0 ? 'partial' : 'unavailable',
    };
  }

  async getPersonalSnapshot(params: {
    userId: string;
    companyId: string;
    limit: number;
    maxFactChars: number;
    maxTotalChars: number;
  }): Promise<string[]> {
    const entries = await this.recallBank(
      personalBankId(params.companyId, params.userId),
      PERSONAL_SNAPSHOT_QUERY,
      params.limit,
    );
    const seen = new Set<string>();
    const facts: string[] = [];
    let totalChars = 0;
    for (const entry of entries.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))) {
      if (!projectedResourceId(entry)) continue;
      const text = entry.text.trim();
      const key = normalizeFact(text);
      if (
        !key
        || seen.has(key)
        || text.length > params.maxFactChars
        || facts.length >= params.limit
        || totalChars + text.length > params.maxTotalChars
      ) continue;
      seen.add(key);
      facts.push(text);
      totalChars += text.length;
    }
    return facts;
  }

  async projectExplicitResource(params: {
    resourceId: string;
    facts: readonly string[];
    previousFactCount: number;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void> {
    const bankId = scopedBankId(params.scope, params);
    await this.client.ensureBank(bankId, { signal: this.signal() });

    // Every index has a stable document ID. Replacing a fact updates the same
    // Hindsight document; shrinking the resource deletes only trailing docs.
    for (let index = params.facts.length; index < params.previousFactCount; index += 1) {
      try {
        await this.client.deleteDocument(bankId, projectedDocumentId(params.resourceId, index), {
          signal: this.signal(),
        });
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }

    const items: MemoryItemInput[] = params.facts.map((fact, index) => ({
      content: fact,
      context: 'Divo knowledge resource',
      metadata: {
        source: 'knowledge_core',
        resource_id: params.resourceId,
        company_id: params.companyId,
        owner_user_id: params.userId,
        scope: params.scope,
        ...(params.departmentId ? { department_id: params.departmentId } : {}),
      },
      document_id: projectedDocumentId(params.resourceId, index),
      tags: ['source:knowledge_core'],
      strategy: 'exact',
      update_mode: 'replace',
    }));
    if (items.length > 0) {
      await this.client.retainBatch(bankId, items, { signal: this.signal() });
    }
  }

  async removeProjectedResource(params: {
    resourceId: string;
    factCount: number;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void> {
    const bankId = scopedBankId(params.scope, params);
    for (let index = 0; index < params.factCount; index += 1) {
      try {
        await this.client.deleteDocument(bankId, projectedDocumentId(params.resourceId, index), {
          signal: this.signal(),
        });
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }
  }

  async projectDocument(params: {
    resourceId: string;
    resourceVersion: number;
    fileName: string;
    scope: MemoryScope;
    companyId: string;
    ownerUserId?: string;
    departmentId?: string;
    chunks: readonly KnowledgeDocumentChunkInput[];
  }): Promise<void> {
    const bankId = documentBankId(params);
    await this.client.ensureBank(bankId, { signal: this.signal() });
    const items: MemoryItemInput[] = params.chunks.map(chunk => ({
      content: documentChunkContent(params.fileName, chunk),
      context: 'Divo governed file',
      metadata: {
        source: 'knowledge_file',
        resource_id: params.resourceId,
        resource_version: String(params.resourceVersion),
        chunk_ordinal: String(chunk.ordinal),
        company_id: params.companyId,
        scope: params.scope,
        file_name: params.fileName,
        ...(params.ownerUserId ? { owner_user_id: params.ownerUserId } : {}),
        ...(params.departmentId ? { department_id: params.departmentId } : {}),
        ...(chunk.pageStart === undefined ? {} : { page_start: String(chunk.pageStart) }),
        ...(chunk.pageEnd === undefined ? {} : { page_end: String(chunk.pageEnd) }),
      },
      document_id: projectedFileDocumentId(params.resourceId, params.resourceVersion, chunk.ordinal),
      tags: ['source:knowledge_file'],
      strategy: 'exact',
      update_mode: 'replace',
    }));
    if (items.length > 0) await this.client.retainBatch(bankId, items, { signal: this.signal() });
  }

  async removeDocument(params: {
    resourceId: string;
    resourceVersion: number;
    chunkCount: number;
    scope: MemoryScope;
    companyId: string;
    ownerUserId?: string;
    departmentId?: string;
  }): Promise<void> {
    const bankId = documentBankId(params);
    for (let ordinal = 0; ordinal < params.chunkCount; ordinal += 1) {
      try {
        await this.client.deleteDocument(
          bankId,
          projectedFileDocumentId(params.resourceId, params.resourceVersion, ordinal),
          { signal: this.signal() },
        );
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }
  }

  async searchDocuments(params: {
    query: string;
    userId: string;
    companyId: string;
    departments: readonly MemoryRecallDepartment[];
    limit: number;
  }): Promise<{
    candidates: readonly KnowledgeDocumentSemanticCandidate[];
    status: 'available' | 'partial' | 'unavailable';
  }> {
    const banks = this.recallBanks(params);
    const settled = await mapSettledBounded(
      banks,
      this.deps.recallConcurrency,
      async bank => ({
        bank,
        entries: await this.client.recall(bank.bankId, params.query, {
          maxTokens: this.deps.recallMaxTokens,
          budget: this.deps.recallBudget,
          tags: ['source:knowledge_file'],
          tagsMatch: 'all_strict',
          signal: this.signal(),
        }),
      }),
    );
    const candidates: KnowledgeDocumentSemanticCandidate[] = [];
    let succeeded = 0;
    for (const result of settled) {
      if (result.status === 'rejected') continue;
      succeeded += 1;
      for (const entry of result.value.entries) {
        const candidate = documentCandidate(entry, result.value.bank);
        if (candidate) candidates.push(candidate);
      }
    }
    const deduped = new Map<string, KnowledgeDocumentSemanticCandidate>();
    for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
      const key = `${candidate.resourceId}:${candidate.resourceVersion}:${candidate.chunkOrdinal}`;
      if (!deduped.has(key)) deduped.set(key, candidate);
    }
    return {
      candidates: [...deduped.values()].slice(0, Math.min(params.limit, this.deps.maxResults * banks.length)),
      status: succeeded === banks.length ? 'available' : succeeded > 0 ? 'partial' : 'unavailable',
    };
  }

  private async recallBank(bankId: string, query: string, limit: number): Promise<HindsightRecallEntry[]> {
    const results = await this.client.recall(bankId, query, {
      maxTokens: this.deps.recallMaxTokens,
      budget: this.deps.recallBudget,
      signal: this.signal(),
    });
    return results.slice(0, limit);
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.deps.requestTimeoutMs);
  }

  private recallBanks(params: {
    companyId: string;
    userId: string;
    departments: readonly MemoryRecallDepartment[];
  }): ScopedBank[] {
    return [
      {
        bankId: personalBankId(params.companyId, params.userId),
        scope: 'personal',
        label: 'User memory',
      },
      ...params.departments.map(department => ({
        bankId: departmentBankId(params.companyId, department.id),
        scope: 'department' as const,
        label: 'Department memory',
        departmentName: department.name,
      })),
      {
        bankId: companyBankId(params.companyId),
        scope: 'company',
        label: 'Company memory',
      },
    ];
  }

}

async function mapSettledBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      try {
        results[index] = { status: 'fulfilled', value: await map(item, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

class SdkHindsightMemoryClient implements HindsightMemoryClient {
  private readonly sdk: HindsightClient;

  constructor(options: { baseUrl: string; apiKey?: string }) {
    this.sdk = new HindsightClient({
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      userAgent: 'divo-backend/1.0',
    });
  }

  async ensureBank(bankId: string, options: {
    signal: AbortSignal;
  }): Promise<void> {
    await this.sdk.createBank(bankId, { signal: options.signal });
  }

  async retainBatch(bankId: string, items: readonly MemoryItemInput[], options: {
    signal: AbortSignal;
  }): Promise<void> {
    await this.sdk.retainBatch(bankId, [...items], options);
  }

  async recall(bankId: string, query: string, options: {
    maxTokens: number;
    budget: Budget;
    tags?: readonly string[];
    tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact';
    signal: AbortSignal;
  }): Promise<HindsightRecallEntry[]> {
    const response: RecallResponse = await this.sdk.recall(bankId, query, {
      maxTokens: options.maxTokens,
      budget: options.budget,
      signal: options.signal,
      ...(options.tags ? { tags: [...options.tags] } : {}),
      ...(options.tagsMatch ? { tagsMatch: options.tagsMatch } : {}),
    });
    return response.results.map(result => ({
      id: result.id,
      text: result.text,
      ...(typeof result.scores?.final === 'number' ? { score: result.scores.final } : {}),
      ...(result.mentioned_at ? { createdAt: result.mentioned_at } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    }));
  }

  async deleteDocument(bankId: string, documentId: string, options: {
    signal: AbortSignal;
  }): Promise<void> {
    await this.sdk.deleteDocument(bankId, documentId, options);
  }

}

export function personalBankId(companyId: string, userId: string): string {
  return `${companyBankPrefix(companyId)}user-${sha256(userId)}`;
}

export function departmentBankId(companyId: string, departmentId: string): string {
  return `${companyBankPrefix(companyId)}department-${sha256(departmentId)}`;
}

export function companyBankId(companyId: string): string {
  return `${companyBankPrefix(companyId)}company`;
}

function companyBankPrefix(companyId: string): string {
  return `divo-v1-company-${sha256(companyId)}-`;
}

function scopedBankId(scope: MemoryScope, params: {
  companyId: string;
  userId: string;
  departmentId?: string;
}): string {
  if (scope === 'personal') return personalBankId(params.companyId, params.userId);
  if (scope === 'company') return companyBankId(params.companyId);
  if (!params.departmentId) throw new Error('departmentId is required for department memory.');
  return departmentBankId(params.companyId, params.departmentId);
}

function documentBankId(params: {
  scope: MemoryScope;
  companyId: string;
  ownerUserId?: string;
  departmentId?: string;
}): string {
  if (params.scope === 'personal') {
    if (!params.ownerUserId) throw new Error('ownerUserId is required for personal file knowledge.');
    return personalBankId(params.companyId, params.ownerUserId);
  }
  if (params.scope === 'department') {
    if (!params.departmentId) throw new Error('departmentId is required for department file knowledge.');
    return departmentBankId(params.companyId, params.departmentId);
  }
  return companyBankId(params.companyId);
}

function selectBoundedFacts(
  candidates: readonly RankedCandidate[],
  params: {
    limit: number;
    maxFactChars: number;
    maxTotalChars: number;
  },
): MemoryRecallFact[] {
  const ranked = [...candidates].sort((left, right) =>
    right.score - left.score
    || left.preferenceRank - right.preferenceRank
    || scopeRank(left.scope) - scopeRank(right.scope)
    || (left.departmentName ?? '').localeCompare(right.departmentName ?? ''),
  );
  const seen = new Set<string>();
  const facts: MemoryRecallFact[] = [];
  let totalChars = 0;
  const add = (candidate: RankedCandidate): boolean => {
    const key = normalizeFact(candidate.text);
    if (
      !key
      || seen.has(key)
      || candidate.text.length > params.maxFactChars
      || facts.length >= params.limit
      || totalChars + candidate.text.length > params.maxTotalChars
    ) return false;
    if (candidate.scope === 'department' && !candidate.departmentName) return false;
    seen.add(key);
    totalChars += candidate.text.length;
    if (candidate.scope === 'personal') {
      facts.push({
        scope: 'personal',
        text: candidate.text,
        ...(candidate.resourceId ? { resourceId: candidate.resourceId } : {}),
      });
    } else if (candidate.scope === 'company') {
      facts.push({
        scope: 'company',
        text: candidate.text,
        ...(candidate.resourceId ? { resourceId: candidate.resourceId } : {}),
      });
    } else {
      facts.push({
        scope: 'department',
        text: candidate.text,
        department: { name: candidate.departmentName! },
        ...(candidate.resourceId ? { resourceId: candidate.resourceId } : {}),
      });
    }
    return true;
  };

  for (const scope of ['personal', 'department', 'company'] as const) {
    ranked.some(candidate => candidate.scope === scope && add(candidate));
  }
  for (const candidate of ranked) add(candidate);
  return facts;
}

function scopeRank(scope: RankedCandidate['scope']): number {
  return scope === 'personal' ? 0 : scope === 'department' ? 1 : 2;
}

function projectedDocumentId(resourceId: string, index: number): string {
  return `divo-knowledge-${sha256(`${resourceId}:${index}`)}`;
}

export function projectedFileDocumentId(resourceId: string, version: number, ordinal: number): string {
  return `divo-file-${sha256(`${resourceId}:${version}:${ordinal}`)}`;
}

function documentChunkContent(fileName: string, chunk: KnowledgeDocumentChunkInput): string {
  const location = chunk.pageStart === undefined
    ? ''
    : chunk.pageStart === chunk.pageEnd ? `Page ${chunk.pageStart}` : `Pages ${chunk.pageStart}-${chunk.pageEnd}`;
  const section = chunk.sectionPath.length > 0 ? chunk.sectionPath.join(' > ') : '';
  return [
    `File: ${fileName}`,
    location,
    section ? `Section: ${section}` : '',
    chunk.text,
  ].filter(Boolean).join('\n');
}

function documentCandidate(entry: HindsightRecallEntry, bank: ScopedBank): KnowledgeDocumentSemanticCandidate | null {
  if (entry.metadata?.['source'] !== 'knowledge_file') return null;
  const resourceId = entry.metadata['resource_id']?.trim();
  const resourceVersion = Number(entry.metadata['resource_version']);
  const chunkOrdinal = Number(entry.metadata['chunk_ordinal']);
  if (!resourceId || !Number.isInteger(resourceVersion) || resourceVersion < 1) return null;
  if (!Number.isInteger(chunkOrdinal) || chunkOrdinal < 0) return null;
  return {
    resourceId,
    resourceVersion,
    chunkOrdinal,
    score: entry.score ?? 0,
    scope: bank.scope,
    ...(bank.departmentName ? { departmentName: bank.departmentName } : {}),
  };
}

function normalizeFact(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function projectedResourceId(entry: HindsightRecallEntry): string | undefined {
  if (entry.metadata?.['source'] !== 'knowledge_core') return undefined;
  const resourceId = entry.metadata['resource_id']?.trim();
  return resourceId || undefined;
}

function normalizeDepartmentName(value: string): string {
  return normalizeFact(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)['statusCode'];
  return typeof value === 'number' ? value : undefined;
}
