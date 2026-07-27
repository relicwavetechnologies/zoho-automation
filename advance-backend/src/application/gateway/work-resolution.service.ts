import type { PermissionResult } from '../permissions/permission.types';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { asToolId } from '../../shared/ids';
import type {
  CatalogSkill,
  CatalogSkillSearchResult,
  SkillCatalogService,
} from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import type {
  ManagerPersonaResolvedRule,
  ManagerPersonaRuntimeService,
} from '../persona-learning/manager-persona-runtime.service';

export interface ResolvedWorkSkill {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly toolIds: readonly string[];
  readonly revision: number;
}

export interface WorkResolution {
  readonly originalQuery: string;
  readonly queries: readonly string[];
  readonly registryRevision: number;
  readonly persona: {
    readonly rules: readonly ManagerPersonaResolvedRule[];
    readonly linkedSkills: readonly {
      readonly source: 'persona_link';
      readonly references: readonly { nodeId: string; scopeKey: string; ruleKey: string }[];
      readonly skill: ResolvedWorkSkill;
    }[];
  };
  readonly additionalSkills: readonly {
    readonly source: 'skill_search';
    readonly matchedQueries: readonly string[];
    readonly bestScore: number;
    readonly reason: string;
    readonly skill: ResolvedWorkSkill;
  }[];
  readonly rejectedSkills: readonly {
    readonly id: string;
    readonly name: string;
    readonly bestScore: number;
    readonly matchedQueries: readonly string[];
    readonly reason: string;
  }[];
  readonly resolutionOrder: readonly string[];
  readonly note: string;
}

export interface WorkResolutionServiceDeps {
  readonly skillCatalog: SkillCatalogService;
  readonly skillAccessEnforcement?: SkillAccessEnforcementPort;
  readonly managerPersonaRuntime?: ManagerPersonaRuntimeService;
}

/**
 * Channel-neutral work-context resolver.
 *
 * Desktop reaches this through the HTTP gateway; backend-hosted channels such
 * as Lark call it in-process. It deliberately resolves only advisory context:
 * every tool invocation is still authorized and approved by the executor.
 */
export class WorkResolutionService {
  constructor(private readonly deps: WorkResolutionServiceDeps) {}

  async resolve(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentId?: string;
    readonly permission: PermissionResult;
    readonly query: string;
    readonly variants?: readonly string[];
    readonly limit?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<WorkResolution> {
    input.abortSignal?.throwIfAborted();
    const queries = uniqueQueries(input.query, input.variants ?? []);
    const discoveryPermission = withWorkDiscoveryPermissions(input.permission);
    const grantedSkillIds = this.deps.skillAccessEnforcement
      ? await this.deps.skillAccessEnforcement.listGrantedSkillIds(
        input.companyId,
        input.userId,
        input.abortSignal,
      )
      : undefined;
    input.abortSignal?.throwIfAborted();

    const [personaRules, searches] = await Promise.all([
      input.departmentId && this.deps.managerPersonaRuntime
        ? this.deps.managerPersonaRuntime.resolveDepartmentRules({
          companyId: input.companyId,
          departmentId: input.departmentId,
          query: input.query,
          limit: 5,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        })
        : Promise.resolve([]),
      Promise.all(queries.map(query => this.deps.skillCatalog.searchVisible({
        companyId: input.companyId,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        permission: discoveryPermission,
        ...(grantedSkillIds ? { grantedSkillIds } : {}),
        query,
        limit: 5,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      }))),
    ]);
    input.abortSignal?.throwIfAborted();

    const personaSkillReferences = new Map<string, Array<{
      nodeId: string;
      scopeKey: string;
      ruleKey: string;
    }>>();
    for (const rule of personaRules) {
      for (const skill of rule.linkedSkills) {
        const references = personaSkillReferences.get(skill.id) ?? [];
        references.push({ nodeId: rule.nodeId, scopeKey: rule.scopeKey, ruleKey: rule.ruleKey });
        personaSkillReferences.set(skill.id, references);
      }
    }

    const personaSkills = (await Promise.all([...personaSkillReferences.entries()].map(async ([skillId, references]) => {
      const skill = await this.deps.skillCatalog.getVisible({
        companyId: input.companyId,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        permission: discoveryPermission,
        ...(grantedSkillIds ? { grantedSkillIds } : {}),
        skillId,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      return skill ? { source: 'persona_link' as const, references, skill: agentFacingSkill(skill) } : null;
    }))).filter(isPresent);
    input.abortSignal?.throwIfAborted();

    const aggregated = aggregateSkillSearches(queries, searches);
    const fuzzyCandidates = aggregated.filter(candidate => !personaSkillReferences.has(candidate.skill.id));
    const personaCoveredCandidates = fuzzyCandidates.filter(candidate =>
      personaSkills.some(personaSkill => similarSkillIntent(candidate.skill, personaSkill.skill)),
    );
    const uncoveredFuzzyCandidates = fuzzyCandidates.filter(candidate =>
      !personaCoveredCandidates.includes(candidate),
    );
    const additionalSkills = uncoveredFuzzyCandidates
      .filter(isStrongSkillMatch)
      .slice(0, input.limit ?? 3)
      .map(candidate => ({
        source: 'skill_search' as const,
        matchedQueries: candidate.matchedQueries,
        bestScore: candidate.bestScore,
        reason: candidate.matchedQueries.length > 1
          ? 'Matched more than one intent-preserving query.'
          : 'Passed the strong fuzzy-match threshold for this request.',
        skill: agentFacingSkill(candidate.skill),
      }));
    const selectedIds = new Set(additionalSkills.map(candidate => candidate.skill.id));
    const rejectedSkills = [
      ...personaCoveredCandidates.map(candidate => ({
        id: candidate.skill.id,
        name: candidate.skill.name,
        bestScore: candidate.bestScore,
        matchedQueries: candidate.matchedQueries,
        reason: 'Superseded by a more specific exact persona-linked skill.',
      })),
      ...uncoveredFuzzyCandidates
        .filter(candidate => !selectedIds.has(candidate.skill.id))
        .map(candidate => ({
          id: candidate.skill.id,
          name: candidate.skill.name,
          bestScore: candidate.bestScore,
          matchedQueries: candidate.matchedQueries,
          reason: isStrongSkillMatch(candidate)
            ? 'Strong complementary match omitted because the bounded result limit was reached.'
            : 'Below the strong relevance threshold; do not apply this recipe automatically.',
        })),
    ].slice(0, 5);

    return {
      originalQuery: input.query,
      queries,
      registryRevision: await registryRevision(
        this.deps.skillCatalog,
        input.companyId,
        input.abortSignal,
      ),
      persona: { rules: personaRules, linkedSkills: personaSkills },
      additionalSkills,
      rejectedSkills,
      resolutionOrder: [
        'Apply the current user request and backend policy.',
        'Apply matching persona rules and their exact linked skill recipes.',
        'Apply complementary skill-search recipes only where they do not conflict.',
        'Use injected personal memory only as a compatible default.',
      ],
      note: 'This resolution is advisory context. Backend permission and approval checks remain authoritative.',
    };
  }
}

export function withWorkDiscoveryPermissions(perm: PermissionResult): PermissionResult {
  const allowedActionsByTool = new Map(perm.allowedActionsByTool);
  const allowedToolIds = new Set(perm.allowedToolIds);

  const memoryPublishingToolId = asToolId('memoryPublishing');
  const memoryActions = new Set<ToolActionGroup>(
    allowedActionsByTool.get(memoryPublishingToolId) ?? [],
  );
  memoryActions.add('read');
  allowedActionsByTool.set(memoryPublishingToolId, memoryActions);
  allowedToolIds.add(memoryPublishingToolId);

  const memoryRecallToolId = asToolId('memoryRecall');
  const recallActions = new Set<ToolActionGroup>(
    allowedActionsByTool.get(memoryRecallToolId) ?? [],
  );
  recallActions.add('read');
  allowedActionsByTool.set(memoryRecallToolId, recallActions);
  allowedToolIds.add(memoryRecallToolId);

  if (perm.department?.roleSlug === 'MANAGER') {
    const skillPublishingToolId = asToolId('skillPublishing');
    const skillActions = new Set<ToolActionGroup>(
      allowedActionsByTool.get(skillPublishingToolId) ?? [],
    );
    skillActions.add('read');
    skillActions.add('create');
    allowedActionsByTool.set(skillPublishingToolId, skillActions);
    allowedToolIds.add(skillPublishingToolId);
  }

  return { ...perm, allowedToolIds, allowedActionsByTool };
}

async function registryRevision(
  catalog: SkillCatalogService,
  companyId: string,
  abortSignal?: AbortSignal,
): Promise<number> {
  abortSignal?.throwIfAborted();
  const revisionReader = catalog as SkillCatalogService & {
    registryRevision?: (requestedCompanyId: string, signal?: AbortSignal) => Promise<number>;
  };
  return revisionReader.registryRevision
    ? await revisionReader.registryRevision(companyId, abortSignal)
    : 1;
}

function uniqueQueries(originalQuery: string, variants: readonly string[]): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const value of [originalQuery, ...variants]) {
    const query = value.replace(/\s+/g, ' ').trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries.slice(0, 3);
}

interface AggregatedSkillCandidate {
  readonly skill: CatalogSkill;
  readonly bestScore: number;
  readonly matchedQueries: readonly string[];
  readonly rankScore: number;
}

function aggregateSkillSearches(
  queries: readonly string[],
  searches: readonly (readonly CatalogSkillSearchResult[])[],
): AggregatedSkillCandidate[] {
  const candidates = new Map<string, {
    skill: CatalogSkill;
    bestScore: number;
    matchedQueries: string[];
    rankScore: number;
  }>();

  searches.forEach((results, queryIndex) => {
    results.forEach((result, rank) => {
      const candidate = candidates.get(result.skill.id) ?? {
        skill: result.skill,
        bestScore: 0,
        matchedQueries: [],
        rankScore: 0,
      };
      candidate.bestScore = Math.max(candidate.bestScore, result.score);
      candidate.rankScore += 1 / (rank + 1);
      const query = queries[queryIndex];
      if (query && !candidate.matchedQueries.includes(query)) candidate.matchedQueries.push(query);
      candidates.set(result.skill.id, candidate);
    });
  });

  return [...candidates.values()]
    .sort((left, right) =>
      right.matchedQueries.length - left.matchedQueries.length
      || right.bestScore - left.bestScore
      || right.rankScore - left.rankScore
      || left.skill.name.localeCompare(right.skill.name),
    );
}

function isStrongSkillMatch(candidate: AggregatedSkillCandidate): boolean {
  return candidate.bestScore >= 8;
}

const skillIntentStopWords = new Set([
  'and', 'company', 'create', 'for', 'from', 'generate', 'system', 'the', 'use', 'using', 'with',
]);

function similarSkillIntent(
  candidate: CatalogSkill,
  personaSkill: { slug: string; name: string; description: string },
): boolean {
  const left = skillIntentTokens(`${candidate.slug} ${candidate.name} ${candidate.description}`);
  const right = skillIntentTokens(`${personaSkill.slug} ${personaSkill.name} ${personaSkill.description}`);
  if (left.size === 0 || right.size === 0) return false;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = new Set([...left, ...right]).size;
  return intersection >= 3 && intersection / union >= 0.3;
}

function skillIntentTokens(value: string): Set<string> {
  return new Set(value.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !skillIntentStopWords.has(token)));
}

function agentFacingSkill(skill: CatalogSkill): ResolvedWorkSkill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    toolIds: [...skill.toolIds],
    revision: skill.revision,
  };
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
