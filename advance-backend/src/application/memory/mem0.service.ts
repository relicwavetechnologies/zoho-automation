import { Memory, type Message, type SearchResult } from 'mem0ai/oss';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { Logger } from '../../shared/logger';
import { MEM0_EXTRACTION_INSTRUCTIONS } from './extraction-instructions';

export type MemoryScope = 'user' | 'department' | 'company';

const MIN_MEMORY_SCORE = 0.3;

export interface MemoryEntry {
  readonly id: string;
  readonly memory: string;
  readonly score?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MemoryExtractionScopeSummary {
  readonly scope: string;
  readonly count: number;
}

export interface MemoryExtractionSummary {
  readonly attemptedScopes: string[];
  readonly storedMemories: number;
  readonly scopes: MemoryExtractionScopeSummary[];
}

export interface MemoryStats {
  readonly totalUser: number;
  readonly totalDepartment: number;
  readonly totalCompany: number;
}

export type MemoryRecallScope = 'personal' | 'department' | 'company';
export type MemoryRecallScopeStatus = 'searched' | 'failed';
export type MemoryRecallStatus = 'available' | 'partial' | 'unavailable';

export interface MemoryRecallDepartment {
  readonly id: string;
  readonly name: string;
}

export type MemoryRecallFact =
  | { readonly scope: 'personal'; readonly text: string }
  | { readonly scope: 'department'; readonly text: string; readonly department: { readonly name: string } }
  | { readonly scope: 'company'; readonly text: string };

export interface MemoryRecallResult {
  readonly facts: MemoryRecallFact[];
  readonly coverage: {
    readonly personal: MemoryRecallScopeStatus;
    readonly departments: { readonly searched: number; readonly failed: number };
    readonly company: MemoryRecallScopeStatus;
  };
  readonly status: MemoryRecallStatus;
}

export class MemoryBatchRolledBackError extends Error {
  constructor(options: { cause: unknown }) {
    super('Memory batch failed and completed writes were rolled back; no facts were published.', options);
    this.name = 'MemoryBatchRolledBackError';
  }
}

export class MemoryBatchIndeterminateError extends Error {
  constructor(options: { cause: unknown }) {
    super('Memory batch failed and rollback could not be fully verified; published memory state is indeterminate and must be reviewed before retrying.', options);
    this.name = 'MemoryBatchIndeterminateError';
  }
}

export interface Mem0ServiceDeps {
  readonly openaiApiKey: string;
  readonly qdrantUrl: string;
  readonly qdrantApiKey?: string;
  readonly collectionName: string;
  readonly extractionModel: string;
  readonly maxResults: number;
  readonly logger: Logger;
  readonly memoryClient?: Mem0MemoryClient;
}

export interface Mem0MemoryClient {
  add(messages: string | Message[], config: {
    userId?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
    infer?: boolean;
  }): Promise<SearchResult>;
  search(query: string, config: {
    topK?: number;
    filters: Record<string, unknown>;
    threshold?: number;
  }): Promise<SearchResult>;
  getAll(config: {
    topK?: number;
    filters: Record<string, unknown>;
  }): Promise<SearchResult>;
  delete(memoryId: string): Promise<{ message: string }>;
  deleteAll(config: { userId?: string; agentId?: string }): Promise<{ message: string }>;
}

interface ScopedSearch {
  readonly scope: MemoryScope;
  readonly label: string;
  readonly filters: Record<string, unknown>;
  readonly departmentName?: string;
}

interface AddTarget {
  readonly entity: { userId?: string; agentId?: string };
  readonly metadata: Record<string, unknown>;
}

export class Mem0Service {
  private readonly memory: Mem0MemoryClient;
  private readonly deps: Mem0ServiceDeps;
  private readonly qdrantDirect: QdrantClient | null;

  constructor(deps: Mem0ServiceDeps) {
    this.deps = deps;
    this.qdrantDirect = !deps.memoryClient
      ? new QdrantClient({
          url: deps.qdrantUrl,
          ...(deps.qdrantApiKey ? { apiKey: deps.qdrantApiKey } : {}),
          checkCompatibility: false,
        })
      : null;
    this.memory = deps.memoryClient ?? new Memory({
      llm: {
        provider: 'openai',
        config: { apiKey: deps.openaiApiKey, model: deps.extractionModel },
      },
      embedder: {
        provider: 'openai',
        config: {
          apiKey: deps.openaiApiKey,
          model: 'text-embedding-3-small',
          embeddingDims: 1536,
        },
      },
      vectorStore: {
        provider: 'qdrant',
        config: {
          url: deps.qdrantUrl,
          ...(deps.qdrantApiKey ? { apiKey: deps.qdrantApiKey } : {}),
          collectionName: deps.collectionName,
          dimension: 1536,
        },
      },
      disableHistory: true,
      customInstructions: MEM0_EXTRACTION_INSTRUCTIONS,
    });
  }

  async searchForContext(params: {
    query: string;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<string> {
    const searches = this.buildSearches(params);
    const settled = await Promise.allSettled(
      searches.map(async search => ({
        ...search,
        entries: await this.searchScope(params.query, search.filters),
      })),
    );

    const grouped = settled.flatMap(result => {
      if (result.status === 'fulfilled') return [result.value];
      this.deps.logger.warn('mem0.search.scope_failed', { error: String(result.reason) });
      return [];
    });

    const context = this.formatContext(grouped);
    const totalMemories = grouped.reduce((sum, g) => sum + g.entries.length, 0);
    if (totalMemories > 0) {
      this.deps.logger.info('mem0.search.found', { memories: totalMemories, contextLength: context.length });
    }
    return context;
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
    const searches = this.buildRecallSearches(params);
    const perScopeLimit = Math.min(this.deps.maxResults, params.limit);
    const settled = await Promise.allSettled(
      searches.map(async search => ({
        ...search,
        entries: await this.searchScope(params.query, search.filters, perScopeLimit),
      })),
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
    const succeeded: Array<ScopedSearch & { entries: MemoryEntry[] }> = [];
    for (let index = 0; index < settled.length; index++) {
      const search = searches[index]!;
      const result = settled[index]!;
      if (result.status === 'fulfilled') {
        if (search.scope === 'user') coverage.personal = 'searched';
        if (search.scope === 'company') coverage.company = 'searched';
        if (search.scope === 'department') coverage.departments.searched++;
        succeeded.push(result.value);
      } else {
        this.deps.logger.warn('mem0.recall.scope_failed', { scope: search.scope, error: String(result.reason) });
        if (search.scope === 'department') coverage.departments.failed++;
      }
    }

    const seen = new Set<string>();
    const facts: MemoryRecallFact[] = [];
    let totalChars = 0;
    const preferenceRank = new Map(
      (params.departmentPreferences ?? []).map((name, index) => [normalizeDepartmentName(name), index]),
    );
    const candidates = succeeded.flatMap(group => group.entries
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map(entry => ({
        scope: toMemoryRecallScope(group.scope),
        text: entry.memory.trim(),
        score: entry.score ?? 0,
        ...(group.departmentName ? { departmentName: group.departmentName } : {}),
        preferenceRank: group.departmentName === undefined
          ? Number.MAX_SAFE_INTEGER
          : preferenceRank.get(normalizeDepartmentName(group.departmentName)) ?? Number.MAX_SAFE_INTEGER,
      })));

    const add = (candidate: { scope: MemoryRecallScope; text: string; departmentName?: string }): boolean => {
      const key = candidate.text.toLowerCase();
      if (
        !candidate.text
        || candidate.text.length > params.maxFactChars
        || seen.has(key)
        || facts.length >= params.limit
        || totalChars + candidate.text.length > params.maxTotalChars
      ) return false;
      seen.add(key);
      totalChars += candidate.text.length;
      if (candidate.scope === 'department' && candidate.departmentName) {
        facts.push({ scope: 'department', text: candidate.text, department: { name: candidate.departmentName } });
      } else if (candidate.scope === 'personal') {
        facts.push({ scope: 'personal', text: candidate.text });
      } else {
        facts.push({ scope: 'company', text: candidate.text });
      }
      return true;
    };

    const rankedCandidates = [...candidates].sort((a, b) =>
      b.score - a.score
      || a.preferenceRank - b.preferenceRank
      || scopeRank(a.scope) - scopeRank(b.scope)
      || (a.departmentName ?? '').localeCompare(b.departmentName ?? ''),
    );

    // Reserve one relevant, bounded fact from personal, any active department,
    // and company scope before filling the remaining global budget.
    for (const scope of ['personal', 'department', 'company'] as const) {
      rankedCandidates.some(item => item.scope === scope && add(item));
    }

    for (const candidate of rankedCandidates) {
      add(candidate);
    }

    return {
      facts,
      coverage,
      status: succeeded.length === searches.length
        ? 'available'
        : succeeded.length > 0 ? 'partial' : 'unavailable',
    };
  }

  async extractAndStore(params: {
    userId: string;
    companyId: string;
    departmentId?: string;
    userRole: string;
    userMessage: string;
    assistantReply: string;
  }): Promise<MemoryExtractionSummary> {
    const log = this.deps.logger;
    if (this.isTrivial(params.userMessage)) {
      return { attemptedScopes: [], storedMemories: 0, scopes: [] };
    }

    const cleanedReply = this.stripActionMarkers(this.stripRecalledMemory(params.assistantReply));
    const messages: Message[] = [
      { role: 'user', content: params.userMessage },
      ...(cleanedReply.length > 20 ? [{ role: 'assistant' as const, content: cleanedReply }] : []),
    ];

    const targets: Array<{ label: string; target: AddTarget }> = [
      { label: 'user', target: this.addTarget('user', params) },
    ];

    // Department and company scopes are explicit-only (via /remember or rememberFact tool).
    // Auto-extraction writes to user scope only — manager conversations may contain
    // confidential content that shouldn't auto-populate the team's shared memory.

    const scopes: MemoryExtractionScopeSummary[] = [];
    for (const { label, target } of targets) {
      try {
        const result = await this.memory.add(messages, {
          ...target.entity,
          metadata: { ...target.metadata, source: 'conversation' },
        });
        const extracted = result?.results?.map((r: { memory?: string }) => r.memory).filter(Boolean) ?? [];
        if (extracted.length > 0) {
          log.info('mem0.learned', { scope: label, facts: extracted });
        }
        scopes.push({ scope: label, count: extracted.length });
      } catch (error) {
        log.warn('mem0.extract.failed', { scope: label, error: error instanceof Error ? error.message : String(error) });
        scopes.push({ scope: label, count: 0 });
      }
    }

    return {
      attemptedScopes: targets.map(target => target.label),
      storedMemories: scopes.reduce((sum, scope) => sum + scope.count, 0),
      scopes,
    };
  }

  async rememberExplicit(params: {
    fact: string;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void> {
    await this.addExplicit(params);
  }

  private async addExplicit(params: {
    fact: string;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<string[]> {
    const target = this.addTarget(params.scope, params);
    const result = await this.memory.add(params.fact, {
      ...target.entity,
      metadata: { ...target.metadata, source: 'explicit' },
      infer: false,
    });
    return result.results
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  async rememberExplicitBatch(params: {
    facts: readonly string[];
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void> {
    const storedIds: string[] = [];
    let writesWithoutIds = 0;

    try {
      for (const fact of params.facts) {
        const ids = await this.addExplicit({
          fact,
          scope: params.scope,
          userId: params.userId,
          companyId: params.companyId,
          ...(params.departmentId ? { departmentId: params.departmentId } : {}),
        });
        if (ids.length === 0) writesWithoutIds++;
        storedIds.push(...ids);
      }
    } catch (cause) {
      const rollback = await Promise.allSettled(
        storedIds.map((memoryId) => this.memory.delete(memoryId)),
      );
      const rollbackFailures = rollback.filter((result) => result.status === 'rejected').length;
      const indeterminate = writesWithoutIds > 0 || rollbackFailures > 0;
      this.deps.logger.warn('mem0.explicit_batch.failed', {
        factCount: params.facts.length,
        completedWrites: storedIds.length + writesWithoutIds,
        rollbackFailures,
        uncompensatableWrites: writesWithoutIds,
        outcome: indeterminate ? 'indeterminate' : 'rolled_back',
      });
      if (indeterminate) throw new MemoryBatchIndeterminateError({ cause });
      throw new MemoryBatchRolledBackError({ cause });
    }
  }

  async listMemories(params: {
    companyId: string;
    userId?: string;
    departmentId?: string;
    scope?: MemoryScope;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const topK = params.limit ?? this.deps.maxResults;
    const searches = this.buildListSearches(params);

    if (searches.length === 0) {
      return this.listAllForCompany(params.companyId, topK, params.scope);
    }

    const results = await Promise.all(
      searches.map(search => this.memory.getAll({ topK, filters: search.filters })),
    );
    return this.dedupeEntries(results.flatMap(result => this.toEntries(result))).slice(0, topK);
  }

  private async listAllForCompany(companyId: string, limit: number, scope?: MemoryScope): Promise<MemoryEntry[]> {
    if (!this.qdrantDirect) return [];
    try {
      const must: Array<{ key: string; match: { value: string } }> = [
        { key: 'company_id', match: { value: companyId } },
      ];
      if (scope) {
        must.push({ key: 'scope', match: { value: scope } });
      }
      const result = await this.qdrantDirect.scroll(this.deps.collectionName, {
        limit: Math.min(limit, 200),
        with_payload: true,
        filter: { must },
      });
      return result.points
        .filter(p => p.payload && (typeof p.payload['data'] === 'string' || typeof p.payload['memory'] === 'string'))
        .map(p => ({
          id: String(p.id),
          memory: String(p.payload!['data'] ?? p.payload!['memory'] ?? ''),
          ...(p.payload!['created_at'] ? { createdAt: String(p.payload!['created_at']) } : {}),
          ...(p.payload!['updated_at'] ? { updatedAt: String(p.payload!['updated_at']) } : {}),
          metadata: p.payload as Record<string, unknown>,
        }));
    } catch (error) {
      this.deps.logger.warn('mem0.listAll.failed', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async deleteMemory(memoryId: string): Promise<void> {
    await this.memory.delete(memoryId);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.memory.deleteAll({ userId });
  }

  async getMemoryStats(params: {
    companyId: string;
  }): Promise<MemoryStats> {
    const [userResult, deptResult, companyResult] = await Promise.allSettled([
      this.memory.getAll({ topK: 1000, filters: { scope: 'user', company_id: params.companyId } }),
      this.memory.getAll({ topK: 1000, filters: { scope: 'department', company_id: params.companyId } }),
      this.memory.getAll({ topK: 1000, filters: { scope: 'company', company_id: params.companyId } }),
    ]);

    return {
      totalUser: userResult.status === 'fulfilled' ? userResult.value.results.length : 0,
      totalDepartment: deptResult.status === 'fulfilled' ? deptResult.value.results.length : 0,
      totalCompany: companyResult.status === 'fulfilled' ? companyResult.value.results.length : 0,
    };
  }

  private async searchScope(
    query: string,
    filters: Record<string, unknown>,
    limit = this.deps.maxResults,
  ): Promise<MemoryEntry[]> {
    const log = this.deps.logger.child({ method: 'searchScope' });
    try {
      log.debug('mem0.searchScope.calling', { queryLength: query.length, filters });
      const result = await this.memory.search(query, {
        topK: limit,
        filters,
      });
      return this.toEntries(result).filter(entry => (entry.score ?? 0) >= MIN_MEMORY_SCORE);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('Bad Request') || msg.includes('Not Found') || msg.includes('not found') || msg.includes('doesn\'t exist')) {
        log.info('mem0.searchScope.collection_not_ready', {
          error: msg,
          hint: 'Collection will be created on first memory.add() call',
        });
        return [];
      }
      log.error('mem0.searchScope.error', {
        error: msg,
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
        filters,
      });
      throw error;
    }
  }

  private buildSearches(params: {
    userId: string;
    companyId: string;
    departmentId?: string;
  }): ScopedSearch[] {
    const searches: ScopedSearch[] = [
      {
        scope: 'user',
        label: 'User memory',
        filters: {
          user_id: params.userId,
          scope: 'user',
          company_id: params.companyId,
        },
      },
      {
        scope: 'company',
        label: 'Company memory',
        filters: {
          agent_id: this.companyAgentId(params.companyId),
          scope: 'company',
          company_id: params.companyId,
        },
      },
    ];

    if (params.departmentId) {
      searches.splice(1, 0, {
        scope: 'department',
        label: 'Team memory',
        filters: {
          agent_id: this.departmentAgentId(params.companyId, params.departmentId),
          scope: 'department',
          company_id: params.companyId,
          department_id: params.departmentId,
        },
      });
    }

    return searches;
  }

  private buildRecallSearches(params: {
    userId: string;
    companyId: string;
    departments: readonly MemoryRecallDepartment[];
  }): ScopedSearch[] {
    return [
      {
        scope: 'user',
        label: 'User memory',
        filters: {
          user_id: params.userId,
          scope: 'user',
          company_id: params.companyId,
        },
      },
      ...params.departments.map(department => ({
        scope: 'department' as const,
        label: 'Department memory',
        departmentName: department.name,
        filters: {
          agent_id: this.departmentAgentId(params.companyId, department.id),
          scope: 'department',
          company_id: params.companyId,
          department_id: department.id,
        },
      })),
      {
        scope: 'company',
        label: 'Company memory',
        filters: {
          agent_id: this.companyAgentId(params.companyId),
          scope: 'company',
          company_id: params.companyId,
        },
      },
    ];
  }

  private buildListSearches(params: {
    companyId: string;
    userId?: string;
    departmentId?: string;
    scope?: MemoryScope;
  }): ScopedSearch[] {
    if (!params.userId && !params.departmentId) {
      return [];
    }

    const requested: MemoryScope[] = params.scope
      ? [params.scope]
      : ['user', 'department', 'company'];
    return requested.flatMap(scope => {
      if (scope === 'user') {
        if (!params.userId) return [];
        const search: ScopedSearch = {
          scope,
          label: 'User memory',
          filters: { user_id: params.userId, scope, company_id: params.companyId },
        };
        return [search];
      }
      if (scope === 'department') {
        if (!params.departmentId) return [];
        const search: ScopedSearch = {
          scope,
          label: 'Team memory',
          filters: {
            agent_id: this.departmentAgentId(params.companyId, params.departmentId),
            scope,
            company_id: params.companyId,
            department_id: params.departmentId,
          },
        };
        return [search];
      }
      const search: ScopedSearch = {
        scope,
        label: 'Company memory',
        filters: {
          agent_id: this.companyAgentId(params.companyId),
          scope,
          company_id: params.companyId,
        },
      };
      return [search];
    });
  }

  private addTarget(scope: MemoryScope, params: {
    userId: string;
    companyId: string;
    departmentId?: string;
  }): AddTarget {
    if (scope === 'user') {
      return {
        entity: { userId: params.userId },
        metadata: {
          scope,
          company_id: params.companyId,
          owner_user_id: params.userId,
        },
      };
    }

    if (scope === 'department') {
      if (!params.departmentId) {
        throw new Error('departmentId is required for department memory scope');
      }
      return {
        entity: { agentId: this.departmentAgentId(params.companyId, params.departmentId) },
        metadata: {
          scope,
          company_id: params.companyId,
          department_id: params.departmentId,
          owner_user_id: params.userId,
        },
      };
    }

    return {
      entity: { agentId: this.companyAgentId(params.companyId) },
      metadata: {
        scope,
        company_id: params.companyId,
        owner_user_id: params.userId,
      },
    };
  }

  private formatContext(
    grouped: Array<ScopedSearch & { entries: MemoryEntry[] }>,
  ): string {
    const seen = new Set<string>();
    const sections = grouped.flatMap(group => {
      const lines = group.entries
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .filter(entry => {
          const key = entry.memory.trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, this.deps.maxResults)
        .map(entry => `- ${entry.memory}`);

      return lines.length > 0 ? [`${group.label}:\n${lines.join('\n')}`] : [];
    });

    return sections.join('\n\n');
  }

  private dedupeEntries(entries: MemoryEntry[]): MemoryEntry[] {
    const seen = new Set<string>();
    return entries.filter(entry => {
      const key = entry.memory.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private toEntries(result: SearchResult): MemoryEntry[] {
    return result.results
      .filter(entry => typeof entry.memory === 'string' && entry.memory.trim().length > 0)
      .map(entry => ({
        id: entry.id,
        memory: entry.memory,
        ...(entry.score !== undefined ? { score: entry.score } : {}),
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      }));
  }

  private isTrivial(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (trimmed.length < 20) return true;
    return [
      /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye|good morning|good evening)[\s!.]*$/i,
      /^\/\w+/,
    ].some(pattern => pattern.test(trimmed));
  }

  private stripActionMarkers(text: string): string {
    return text
      .replace(/\[Actions\][\s\S]*?\[Reply\]\n?/g, '')
      .trim();
  }

  private stripRecalledMemory(text: string): string {
    return text
      .replace(/MEMORY CONTEXT[\s\S]*?(?=\n\n[A-Z]|\n\n##|$)/g, '')
      .replace(/User context \(from memory\):[\s\S]*?(?=\n\n|$)/g, '')
      .replace(/User memory:[\s\S]*?(?=\n\n|$)/g, '')
      .replace(/Team memory:[\s\S]*?(?=\n\n|$)/g, '')
      .replace(/Company memory:[\s\S]*?(?=\n\n|$)/g, '')
      .replace(/- User prefers[\s\S]*?(?=\n-|\n\n|$)/g, '')
      .replace(/- Team uses[\s\S]*?(?=\n-|\n\n|$)/g, '')
      .replace(/- Company uses[\s\S]*?(?=\n-|\n\n|$)/g, '')
      .trim();
  }

  private companyAgentId(companyId: string): string {
    return `company:${companyId}`;
  }

  private departmentAgentId(companyId: string, departmentId: string): string {
    return `company:${companyId}:department:${departmentId}`;
  }
}

function toMemoryRecallScope(scope: MemoryScope): MemoryRecallScope {
  return scope === 'user' ? 'personal' : scope;
}

function scopeRank(scope: MemoryRecallScope): number {
  return scope === 'personal' ? 0 : scope === 'department' ? 1 : 2;
}

function normalizeDepartmentName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
