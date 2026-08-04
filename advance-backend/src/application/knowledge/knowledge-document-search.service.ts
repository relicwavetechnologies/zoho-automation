import type { ChannelKey } from '../../domain/channel/incoming-message';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import { asCompanyId, asToolId, asUserId } from '../../shared/ids';
import type { PermissionService } from '../permissions/permission.service';
import type { KnowledgeDocumentSemanticCandidate, KnowledgeDocumentSemanticIndex } from './knowledge-document.port';
import type { CanonicalKnowledgeDocumentChunk, KnowledgeDocumentRepository } from './knowledge-document.repository';

export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_QUERY_CHARS = 800;
export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS = 8;
export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_EXCERPT_CHARS = 1_600;
export const KNOWLEDGE_DOCUMENT_SEARCH_MAX_TOTAL_CHARS = 7_000;

export interface KnowledgeDocumentSearchResult {
  readonly status: 'available' | 'partial' | 'unavailable';
  readonly degradation?: 'canonical_hydration_failed';
  readonly results: readonly {
    readonly resourceId: string;
    readonly scope: 'personal' | 'department' | 'company';
    readonly fileName: string;
    readonly excerpt: string;
    readonly pageStart?: number;
    readonly pageEnd?: number;
    readonly sectionPath: readonly string[];
    readonly department?: { readonly name: string };
  }[];
}

/** Permission-first hybrid retrieval with canonical chunk hydration. */
export class KnowledgeDocumentSearchService {
  constructor(private readonly deps: {
    readonly documents: KnowledgeDocumentRepository;
    readonly semantic: KnowledgeDocumentSemanticIndex | null;
    readonly departments: Pick<DepartmentRepoPort, 'listActiveMemberships'>;
    readonly permissions: Pick<PermissionService, 'canInvoke'>;
  }) {}

  async search(input: {
    readonly query: string;
    readonly companyId: string;
    readonly userId: string;
    readonly companyRole: string;
    readonly channel: ChannelKey;
    readonly abortSignal?: AbortSignal;
  }): Promise<KnowledgeDocumentSearchResult> {
    const signal = input.abortSignal;
    throwIfAborted(signal);
    const query = input.query.normalize('NFKC').trim();
    if (!query || query.length > KNOWLEDGE_DOCUMENT_SEARCH_MAX_QUERY_CHARS) {
      throw new Error('Document search query is empty or too long.');
    }
    const allowed = await withAbort(this.deps.permissions.canInvoke({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      channel: input.channel,
    }, { toolId: asToolId('knowledge'), action: 'read' }), signal);
    if (!allowed.ok) throw allowed.error;
    const memberships = await withAbort(
      this.deps.departments.listActiveMemberships(input.userId, input.companyId),
      signal,
    );
    if (!memberships.ok) throw memberships.error;
    const departments = memberships.value.map(item => ({ id: item.departmentId, name: item.departmentName }));
    const base = {
      companyId: input.companyId,
      userId: input.userId,
      departmentIds: departments.map(department => department.id),
      query,
      limit: KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS * 4,
    };
    const [keywordAttempt, semanticAttempt] = await withAbort(Promise.allSettled([
      this.deps.documents.keywordSearch(base),
      this.deps.semantic
        ? this.deps.semantic.searchDocuments({
            query,
            userId: input.userId,
            companyId: input.companyId,
            departments,
            limit: KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS * 4,
          })
        : Promise.reject(new Error('Semantic document search is unavailable.')),
    ]), signal);
    throwIfAborted(signal);
    const keyword = keywordAttempt.status === 'fulfilled' ? keywordAttempt.value : [];
    const semantic = semanticAttempt.status === 'fulfilled'
      ? semanticAttempt.value
      : { candidates: [], status: 'unavailable' as const };
    const fused = reciprocalRankFuse(keyword, semantic.candidates);
    let hydrated: readonly CanonicalKnowledgeDocumentChunk[];
    try {
      hydrated = await withAbort(this.deps.documents.hydrateAuthorized({
        companyId: input.companyId,
        userId: input.userId,
        departmentIds: departments.map(department => department.id),
        candidates: fused,
      }), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        status: 'unavailable',
        degradation: 'canonical_hydration_failed',
        results: [],
      };
    }
    throwIfAborted(signal);
    const results = boundResults(hydrated);
    const keywordAvailable = keywordAttempt.status === 'fulfilled';
    return {
      status: semantic.status === 'available' && keywordAvailable
        ? 'available'
        : semantic.status !== 'unavailable' || keywordAvailable ? 'partial' : 'unavailable',
      results,
    };
  }
}

function reciprocalRankFuse(
  keyword: readonly KnowledgeDocumentSemanticCandidate[],
  semantic: readonly KnowledgeDocumentSemanticCandidate[],
): KnowledgeDocumentSemanticCandidate[] {
  const scores = new Map<string, {
    candidate: KnowledgeDocumentSemanticCandidate;
    score: number;
    firstSeen: number;
  }>();
  let firstSeen = 0;
  for (const list of [keyword, semantic]) {
    list.forEach((candidate, rank) => {
      const key = `${candidate.resourceId}:${candidate.resourceVersion}:${candidate.chunkOrdinal}`;
      const current = scores.get(key);
      const score = (current?.score ?? 0) + 1 / (60 + rank + 1);
      scores.set(key, {
        candidate,
        score,
        firstSeen: current?.firstSeen ?? firstSeen++,
      });
    });
  }
  return [...scores.values()]
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      const relevanceOrder = Math.abs(scoreDifference) < 1e-9 ? 0 : scoreDifference;
      return relevanceOrder
      || documentScopeRank(right.candidate.scope) - documentScopeRank(left.candidate.scope)
      || left.firstSeen - right.firstSeen;
    })
    .map(({ candidate, score }) => ({ ...candidate, score }));
}

function documentScopeRank(scope: KnowledgeDocumentSemanticCandidate['scope']): number {
  return scope === 'company' ? 3 : scope === 'department' ? 2 : 1;
}

function boundResults(candidates: readonly CanonicalKnowledgeDocumentChunk[]): KnowledgeDocumentSearchResult['results'] {
  const results: Array<KnowledgeDocumentSearchResult['results'][number]> = [];
  let totalChars = 0;
  for (const candidate of candidates) {
    if (results.length >= KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS) break;
    const excerpt = candidate.text.trim().slice(0, KNOWLEDGE_DOCUMENT_SEARCH_MAX_EXCERPT_CHARS);
    if (!excerpt || totalChars + excerpt.length > KNOWLEDGE_DOCUMENT_SEARCH_MAX_TOTAL_CHARS) continue;
    totalChars += excerpt.length;
    results.push({
      resourceId: candidate.resourceId,
      scope: candidate.scope,
      fileName: candidate.fileName,
      excerpt,
      ...(candidate.pageStart === undefined ? {} : { pageStart: candidate.pageStart }),
      ...(candidate.pageEnd === undefined ? {} : { pageEnd: candidate.pageEnd }),
      sectionPath: candidate.sectionPath,
      ...(candidate.departmentName ? { department: { name: candidate.departmentName } } : {}),
    });
  }
  return results;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The document search was interrupted.', 'AbortError');
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The document search was interrupted.', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}
