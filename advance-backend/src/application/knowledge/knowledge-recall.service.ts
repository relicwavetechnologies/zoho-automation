import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import type {
  MemoryRecallFact,
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

export type KnowledgeRecallResult = MemoryRecallResult | {
  readonly facts: [];
  readonly coverage: {
    readonly personal: 'failed';
    readonly departments: { readonly searched: 0; readonly failed: number };
    readonly company: 'failed';
  };
  readonly status: 'storage_unavailable';
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
  }): Promise<KnowledgeRecallResult> {
    const allowed = await this.deps.permissions.canInvoke({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      channel: input.channel,
    }, {
      toolId: asToolId('knowledge'),
      action: 'read',
    });
    if (!allowed.ok) throw allowed.error;

    const memberships = await this.deps.departments.listActiveMemberships(
      input.userId,
      input.companyId,
    );
    if (!memberships.ok) throw memberships.error;

    const departments = memberships.value.map(membership => ({
      id: membership.departmentId,
      name: membership.departmentName,
    }));
    const [keywordAttempt, semanticAttempt] = await Promise.allSettled([
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
            departments,
            ...(input.departmentPreferences
              ? { departmentPreferences: input.departmentPreferences }
              : {}),
            limit: KNOWLEDGE_RECALL_MAX_FACTS,
            maxFactChars: KNOWLEDGE_RECALL_MAX_FACT_CHARS,
            maxTotalChars: KNOWLEDGE_RECALL_MAX_TOTAL_CHARS,
          })
        : Promise.reject(new Error('Semantic memory is unavailable.')),
    ]);
    if (keywordAttempt.status === 'rejected' && semanticAttempt.status === 'rejected') {
      return {
        facts: [],
        coverage: {
          personal: 'failed',
          departments: { searched: 0, failed: departments.length },
          company: 'failed',
        },
        status: 'storage_unavailable',
      };
    }
    const semantic = semanticAttempt.status === 'fulfilled'
      ? semanticAttempt.value
      : null;
    const semanticFacts = semantic
      ? await this.hydrateCanonicalFacts(input, semantic.facts)
      : [];
    const keywordFacts = keywordAttempt.status === 'fulfilled'
      ? keywordAttempt.value.flatMap(match => canonicalResourceFacts(match.resource))
      : [];
    const bothAvailable = semantic !== null
      && semantic.status === 'available'
      && keywordAttempt.status === 'fulfilled';
    return {
      facts: boundCanonicalFacts([...semanticFacts, ...keywordFacts]),
      coverage: semantic?.coverage ?? {
        personal: 'searched',
        departments: { searched: departments.length, failed: 0 },
        company: 'searched',
      },
      status: bothAvailable ? 'available' : 'partial',
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
        if (resource.scope === 'personal') expanded.push({ scope: 'personal', text });
        else if (resource.scope === 'company') expanded.push({ scope: 'company', text });
        else if (resource.department) {
          expanded.push({
            scope: 'department',
            text,
            department: { name: resource.department.name },
          });
        }
      }
    }

    return boundCanonicalFacts(expanded);
  }
}

function canonicalResourceFacts(
  resource: Awaited<ReturnType<KnowledgeResourceQueryService['getManyMemories']>>[number],
): MemoryRecallFact[] {
  const content = knowledgeMemoryContentSchema.safeParse(resource.content);
  if (!content.success) return [];
  const facts: MemoryRecallFact[] = [];
  for (const text of content.data.facts) {
    if (resource.scope === 'personal') facts.push({ scope: 'personal', text });
    else if (resource.scope === 'company') facts.push({ scope: 'company', text });
    else if (resource.department) {
      facts.push({
        scope: 'department',
        text,
        department: { name: resource.department.name },
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

  for (const scope of ['personal', 'department', 'company'] as const) {
    candidates.some(candidate => candidate.scope === scope && add(candidate));
  }
  for (const candidate of candidates) add(candidate);
  return result;
}
