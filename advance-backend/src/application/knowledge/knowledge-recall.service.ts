import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import type {
  MemoryRecallFact,
  MemoryRecallScopeStatus,
  MemoryRecallResult,
  MemoryService,
} from './semantic-memory.port';
import type { KnowledgeResourceQueryService } from './knowledge-resource-query.service';
import { knowledgeMemoryContentSchema } from './knowledge-content-validator';
import type { PermissionService } from '../permissions/permission.service';
import { asCompanyId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ChannelKey } from '../../domain/channel/incoming-message';

export const KNOWLEDGE_RECALL_MAX_QUERY_CHARS = 500;
export const KNOWLEDGE_RECALL_MAX_FACTS = 12;
export const KNOWLEDGE_RECALL_MAX_FACT_CHARS = 500;
export const KNOWLEDGE_RECALL_MAX_TOTAL_CHARS = 3_000;
export const KNOWLEDGE_RECALL_MAX_DEPARTMENT_PREFERENCES = 5;
export const KNOWLEDGE_RECALL_MAX_DEPARTMENT_NAME_CHARS = 120;

export type KnowledgeRecallAudience = 'private' | 'shared';

type KnowledgeRecallCoverage = {
  readonly personal: MemoryRecallScopeStatus;
  readonly departments: { readonly searched: number; readonly failed: number };
  readonly company: MemoryRecallScopeStatus;
};

type KnowledgeRecallDegradation = 'canonical_hydration_failed';

export type KnowledgeRecallResult = {
  readonly facts: MemoryRecallFact[];
  readonly coverage: KnowledgeRecallCoverage;
  readonly status: MemoryRecallResult['status'];
  readonly personalScope?: 'skipped';
  readonly degradation?: KnowledgeRecallDegradation;
} | {
  readonly facts: [];
  readonly coverage: KnowledgeRecallCoverage;
  readonly status: 'storage_unavailable';
  readonly personalScope?: 'skipped';
  readonly degradation?: KnowledgeRecallDegradation;
};

/**
 * Permission-first hybrid recall. Postgres is the canonical keyword path and
 * Hindsight is a semantic projection; either may degrade without turning the
 * other into authorization. Callers cannot provide scope IDs.
 */
export class KnowledgeRecallService {
  constructor(private readonly deps: {
    readonly memory: Pick<MemoryService, 'searchForRecall'> | null;
    readonly departments: Pick<DepartmentRepoPort, 'listActiveMemberships'>;
    readonly permissions: Pick<PermissionService, 'canInvoke'>;
    readonly resources: Pick<KnowledgeResourceQueryService, 'getManyMemories' | 'searchMemories'>;
  }) {}

  async recall(input: {
    readonly query: string;
    readonly companyId: string;
    readonly userId: string;
    readonly companyRole: string;
    readonly channel: ChannelKey;
    readonly departmentPreferences?: readonly string[];
    /** Derived by the trusted channel runtime; callers cannot select scope IDs. */
    readonly audience?: KnowledgeRecallAudience;
    readonly abortSignal?: AbortSignal;
  }): Promise<KnowledgeRecallResult> {
    const signal = input.abortSignal;
    throwIfAborted(signal);
    const audience = input.audience ?? 'private';
    const allowed = await withAbort(this.deps.permissions.canInvoke({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      channel: input.channel,
    }, {
      toolId: asToolId('knowledge'),
      action: 'read',
    }), signal);
    if (!allowed.ok) throw allowed.error;

    const memberships = await withAbort(this.deps.departments.listActiveMemberships(
      input.userId,
      input.companyId,
    ), signal);
    if (!memberships.ok) throw memberships.error;

    const departments = memberships.value.map(membership => ({
      id: membership.departmentId,
      name: membership.departmentName,
    }));
    const [keywordAttempt, semanticAttempt] = await withAbort(Promise.allSettled([
      this.deps.resources.searchMemories({
        companyId: input.companyId,
        userId: input.userId,
        query: input.query,
        limit: KNOWLEDGE_RECALL_MAX_FACTS * 2,
      }),
      this.deps.memory
        ? this.deps.memory.searchForRecall({
            query: input.query,
            userId: input.userId,
            companyId: input.companyId,
            includePersonal: audience !== 'shared',
            departments,
            ...(input.departmentPreferences
              ? { departmentPreferences: input.departmentPreferences }
              : {}),
            limit: KNOWLEDGE_RECALL_MAX_FACTS,
            maxFactChars: KNOWLEDGE_RECALL_MAX_FACT_CHARS,
            maxTotalChars: KNOWLEDGE_RECALL_MAX_TOTAL_CHARS,
          })
        : Promise.reject(new Error('Semantic memory is unavailable.')),
    ]), signal);
    if (keywordAttempt.status === 'rejected' && semanticAttempt.status === 'rejected') {
      return {
        facts: [],
        coverage: failedCoverage(departments.length),
        status: 'storage_unavailable',
        ...(audience === 'shared' ? { personalScope: 'skipped' as const } : {}),
      };
    }
    const semantic = semanticAttempt.status === 'fulfilled'
      ? semanticAttempt.value
      : null;
    let semanticFacts: MemoryRecallFact[] = [];
    let hydrationFailed = false;
    if (semantic) {
      try {
        const authorizedFacts = audience === 'shared'
          ? semantic.facts.filter(fact => fact.scope !== 'personal')
          : semantic.facts;
        semanticFacts = await withAbort(
          this.hydrateCanonicalFacts(input, authorizedFacts),
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        hydrationFailed = true;
      }
    }
    const keywordFacts = keywordAttempt.status === 'fulfilled'
      ? keywordAttempt.value
        .filter(match => audience !== 'shared' || match.resource.scope !== 'personal')
        .flatMap(match => canonicalResourceFacts(match.resource))
      : [];
    const bothAvailable = semantic !== null
      && !hydrationFailed
      && semantic.status === 'available'
      && keywordAttempt.status === 'fulfilled';
    return {
      facts: boundCanonicalFacts([...semanticFacts, ...keywordFacts]),
      coverage: semantic?.coverage ?? {
        personal: 'searched',
        departments: { searched: departments.length, failed: 0 },
        company: 'searched',
      },
      ...(audience === 'shared' ? { personalScope: 'skipped' as const } : {}),
      status: bothAvailable
        ? 'available'
        : keywordAttempt.status === 'fulfilled' ? 'partial' : 'unavailable',
      ...(hydrationFailed ? { degradation: 'canonical_hydration_failed' as const } : {}),
    };
  }

  private async hydrateCanonicalFacts(
    identity: { readonly companyId: string; readonly userId: string },
    semanticFacts: readonly MemoryRecallFact[],
  ): Promise<MemoryRecallFact[]> {
    const resourceIds = [...new Set(
      semanticFacts.flatMap(fact => fact.resourceId ? [fact.resourceId] : []),
    )];
    const resources = resourceIds.length > 0
      ? await this.deps.resources.getManyMemories({
          companyId: identity.companyId,
          userId: identity.userId,
          resourceIds,
        })
      : [];
    const byId = new Map(resources.map(resource => [resource.resourceId, resource]));
    const expandedResourceIds = new Set<string>();
    const expanded: MemoryRecallFact[] = [];

    for (const semantic of semanticFacts) {
      // Semantic rows without a canonical resource ID predate the governed
      // store. They cannot be re-authorized or version-checked and are dropped.
      if (!semantic.resourceId) continue;
      if (expandedResourceIds.has(semantic.resourceId)) continue;
      expandedResourceIds.add(semantic.resourceId);
      const resource = byId.get(semantic.resourceId);
      if (!resource || resource.scope !== semantic.scope) continue;
      const content = knowledgeMemoryContentSchema.safeParse(resource.content);
      if (!content.success) continue;
      for (const text of content.data.facts) {
        if (resource.scope === 'personal') {
          expanded.push({ scope: 'personal', text, resourceId: resource.resourceId });
        } else if (resource.scope === 'company') {
          expanded.push({ scope: 'company', text, resourceId: resource.resourceId });
        } else if (resource.department) {
          expanded.push({
            scope: 'department',
            text,
            department: { name: resource.department.name },
            resourceId: resource.resourceId,
          });
        }
      }
    }

    return expanded;
  }
}

function canonicalResourceFacts(
  resource: Awaited<ReturnType<KnowledgeResourceQueryService['getManyMemories']>>[number],
): MemoryRecallFact[] {
  const content = knowledgeMemoryContentSchema.safeParse(resource.content);
  if (!content.success) return [];
  const facts: MemoryRecallFact[] = [];
  for (const text of content.data.facts) {
    if (resource.scope === 'personal') {
      facts.push({ scope: 'personal', text, resourceId: resource.resourceId });
    } else if (resource.scope === 'company') {
      facts.push({ scope: 'company', text, resourceId: resource.resourceId });
    } else if (resource.department) {
      facts.push({
        scope: 'department',
        text,
        department: { name: resource.department.name },
        resourceId: resource.resourceId,
      });
    }
  }
  return facts;
}

function stripResourceId(fact: MemoryRecallFact): MemoryRecallFact {
  if (fact.scope === 'department') {
    return { scope: fact.scope, text: fact.text, department: fact.department };
  }
  return { scope: fact.scope, text: fact.text };
}

function boundCanonicalFacts(candidates: readonly MemoryRecallFact[]): MemoryRecallFact[] {
  const result: MemoryRecallFact[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  const add = (fact: MemoryRecallFact): boolean => {
    const text = fact.text.trim();
    const key = text.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
    if (
      !key
      || seen.has(key)
      || text.length > KNOWLEDGE_RECALL_MAX_FACT_CHARS
      || result.length >= KNOWLEDGE_RECALL_MAX_FACTS
      || totalChars + text.length > KNOWLEDGE_RECALL_MAX_TOTAL_CHARS
    ) return false;
    seen.add(key);
    totalChars += text.length;
    result.push(stripResourceId({ ...fact, text }));
    return true;
  };

  // Reserve one result per scope in policy precedence order. The second pass
  // keeps the original relevance order, so precedence cannot erase useful
  // facts merely because a higher-priority scope had many matches.
  for (const scope of ['company', 'department', 'personal'] as const) {
    candidates.some(candidate => candidate.scope === scope && add(candidate));
  }
  for (const candidate of candidates) add(candidate);
  return result;
}

function failedCoverage(departmentCount: number): KnowledgeRecallResult['coverage'] {
  return {
    personal: 'failed',
    departments: { searched: 0, failed: departmentCount },
    company: 'failed',
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The knowledge retrieval was interrupted.', 'AbortError');
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The knowledge retrieval was interrupted.', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}
