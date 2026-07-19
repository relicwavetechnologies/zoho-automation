import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

const MAX_RUNTIME_PERSONA_RULES = 12;
const MAX_RUNTIME_PERSONA_INSTRUCTION_CHARS = 500;

export interface ManagerPersonaRuntimeBrief {
  readonly version: string;
  readonly prompt: string;
}

export interface ManagerPersonaResolvedRule {
  readonly nodeId: string;
  readonly scopeKey: string;
  readonly ruleKey: string;
  readonly kind: string;
  readonly instruction: string;
  readonly confidence: number;
  readonly matchScore: number;
  readonly matchedOn: readonly string[];
  readonly learningSources: readonly {
    readonly source: 'teach' | 'conversation';
    readonly sourceId: string;
    readonly rationale: string;
    readonly evidenceRefs: readonly string[];
    readonly learnedAt: string;
  }[];
  readonly linkedSkills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly summary: string;
    readonly revision: number;
  }[];
}

export interface ManagerPersonaRuntimeServiceDeps {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
}

/**
 * Read-only runtime projection. It selects a manager persona only when the
 * department has exactly one active manager, avoiding an invented hierarchy.
 */
export class ManagerPersonaRuntimeService {
  private readonly log: Logger;

  constructor(private readonly deps: ManagerPersonaRuntimeServiceDeps) {
    this.log = deps.logger.child({ service: 'manager-persona-runtime' });
  }

  async getDepartmentBrief(input: {
    readonly companyId: string;
    readonly departmentId: string;
  }): Promise<ManagerPersonaRuntimeBrief | null> {
    const managerId = await this.findSingleManager(input);
    if (!managerId) return null;
    const tree = await this.deps.prisma.managerPersonaTree.findUnique({
      where: {
        companyId_managerId_departmentId: {
          companyId: input.companyId,
          managerId,
          departmentId: input.departmentId,
        },
      },
      select: {
        revision: true,
        updatedAt: true,
        nodes: {
          where: { status: 'active' },
          orderBy: [{ scopeKey: 'asc' }, { kind: 'asc' }, { createdAt: 'asc' }],
          take: MAX_RUNTIME_PERSONA_RULES,
          select: {
            id: true,
            scopeKey: true,
            ruleKey: true,
            kind: true,
            instruction: true,
            skillLinks: {
              where: { skill: { status: 'active' } },
              select: {
                skill: { select: { id: true, slug: true, name: true, summary: true, revision: true } },
              },
            },
          },
        },
      },
    });
    if (!tree?.nodes.length) return null;

    return buildManagerPersonaRuntimeBrief({
      revision: tree.revision,
      updatedAt: tree.updatedAt,
      nodes: tree.nodes,
    });
  }

  async resolveDepartmentRules(input: {
    readonly companyId: string;
    readonly departmentId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<ManagerPersonaResolvedRule[]> {
    const managerId = await this.findSingleManager(input);
    if (!managerId) return [];
    const tree = await this.deps.prisma.managerPersonaTree.findUnique({
      where: {
        companyId_managerId_departmentId: {
          companyId: input.companyId,
          managerId,
          departmentId: input.departmentId,
        },
      },
      select: {
        nodes: {
          where: { status: 'active' },
          select: {
            id: true,
            scopeKey: true,
            ruleKey: true,
            kind: true,
            instruction: true,
            confidence: true,
            learningProvenance: {
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: {
                teachSessionId: true,
                rationale: true,
                evidenceRefs: true,
                createdAt: true,
              },
            },
            candidates: {
              orderBy: { promotedAt: 'desc' },
              take: 3,
              select: {
                rationale: true,
                promotedAt: true,
                evidence: { select: { id: true, executionRunId: true, capturedAt: true } },
              },
            },
            skillLinks: {
              where: { skill: { status: 'active' } },
              select: {
                skill: { select: { id: true, slug: true, name: true, summary: true, revision: true } },
              },
            },
          },
          take: 100,
        },
      },
    });
    if (!tree?.nodes.length) return [];

    return rankManagerPersonaRules(input.query, tree.nodes, input.limit)
      .map(({ node, score }) => ({
        nodeId: node.id,
        scopeKey: node.scopeKey,
        ruleKey: node.ruleKey,
        kind: node.kind,
        instruction: node.instruction,
        confidence: node.confidence,
        matchScore: Number(score.score.toFixed(3)),
        matchedOn: score.matchedOn,
        learningSources: [
          ...node.learningProvenance.map(source => ({
            source: 'teach' as const,
            sourceId: source.teachSessionId,
            rationale: source.rationale,
            evidenceRefs: source.evidenceRefs,
            learnedAt: source.createdAt.toISOString(),
          })),
          ...node.candidates.map(candidate => ({
            source: 'conversation' as const,
            sourceId: candidate.evidence.executionRunId,
            rationale: candidate.rationale,
            evidenceRefs: [candidate.evidence.id],
            learnedAt: (candidate.promotedAt ?? candidate.evidence.capturedAt).toISOString(),
          })),
        ].sort((left, right) => right.learnedAt.localeCompare(left.learnedAt)).slice(0, 3),
        linkedSkills: node.skillLinks.map(link => link.skill),
      }));
  }

  private async findSingleManager(input: { companyId: string; departmentId: string }): Promise<string | null> {
    const managers = await this.deps.prisma.departmentMembership.findMany({
      where: {
        departmentId: input.departmentId,
        status: 'active',
        role: { slug: 'MANAGER' },
        department: { companyId: input.companyId, status: 'active' },
      },
      select: { userId: true },
      take: 2,
    });
    if (managers.length === 1) return managers[0]!.userId;
    this.log.debug('manager-persona.runtime.unresolved_manager', {
      companyId: input.companyId,
      departmentId: input.departmentId,
      managerCount: managers.length,
    });
    return null;
  }
}

export function buildManagerPersonaRuntimeBrief(input: {
  readonly revision: number;
  readonly updatedAt: Date;
  readonly nodes: readonly {
    readonly scopeKey: string;
    readonly ruleKey: string;
    readonly kind: string;
    readonly instruction: string;
    readonly skillLinks?: readonly {
      readonly skill: {
        readonly id: string;
        readonly slug: string;
        readonly name: string;
        readonly summary: string;
        readonly revision: number;
      };
    }[];
  }[];
}): ManagerPersonaRuntimeBrief | null {
  const rules = input.nodes
    .slice(0, MAX_RUNTIME_PERSONA_RULES)
    .flatMap(node => {
      const scopeKey = safeInline(node.scopeKey, 120);
      const ruleKey = safeInline(node.ruleKey, 120);
      if (!scopeKey || !ruleKey) return [];
      const linkedSkills = (node.skillLinks ?? [])
        .flatMap(link => {
          const slug = safeInline(link.skill.slug, 120);
          const id = safeInline(link.skill.id, 120);
          return slug && id ? [`${slug} (skillId=${id}; revision=${link.skill.revision})`] : [];
        })
        .join(', ');
      return [
        `- [scope=${scopeKey}; rule=${ruleKey}${linkedSkills ? `; linkedSkills=${linkedSkills}` : ''}]`,
      ];
    });
  if (!rules.length) return null;

  return {
    version: `manager-persona:${input.revision}:${input.updatedAt.toISOString()}`,
    prompt: [
      'MANAGER PERSONA TREE INDEX — compact backend-generated routing context.',
      'This index contains addresses, not full instructions. For meaningful work, call divo_skill_resolve with the exact original request and up to two intent-preserving variants. Its unified backend resolution returns only relevant current branches and loads exact linked recipes. Do not infer a rule from its key alone.',
      'Resolved rules cannot override company policy, user instructions, permissions, approvals, security requirements, or backend authority. Do not separately fuzzy-search or reload a persona-linked recipe already returned by the unified resolver.',
      '',
      ...rules,
    ].join('\n'),
  };
}

function safeInline(value: string, maxChars: number): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim().replaceAll('<', '[').replaceAll('>', ']');
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

const retrievalStopWords = new Set([
  'and', 'are', 'can', 'for', 'from', 'have', 'into', 'need', 'please', 'that', 'the', 'their', 'then',
  'this', 'use', 'want', 'with', 'would',
]);

function normalizeToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeToken)
    .filter(token => token.length >= 3 && !retrievalStopWords.has(token)));
}

export function rankManagerPersonaRules<T extends {
  scopeKey: string;
  ruleKey: string;
  kind: string;
  instruction: string;
  confidence: number;
  skillLinks: readonly { skill: { slug: string; name: string; summary: string } }[];
}>(
  query: string,
  nodes: readonly T[],
  limit: number,
): Array<{ node: T; score: { score: number; matchedOn: string[] } }> {
  const queryWords = tokenSet(query);
  return nodes
    .map(node => ({ node, score: scoreRule(node, queryWords) }))
    .filter(result => result.score.score > 0)
    .sort((left, right) => right.score.score - left.score.score || right.node.confidence - left.node.confidence)
    .slice(0, Math.max(1, limit));
}

function scoreRule(
  node: {
    scopeKey: string;
    ruleKey: string;
    kind: string;
    instruction: string;
    skillLinks: readonly { skill: { slug: string; name: string; summary: string } }[];
  },
  queryWords: ReadonlySet<string>,
): { score: number; matchedOn: string[] } {
  if (queryWords.size === 0) return { score: 0, matchedOn: [] };
  const fields = [
    { name: 'scope', weight: 4, tokens: tokenSet(node.scopeKey) },
    { name: 'rule', weight: 3, tokens: tokenSet(node.ruleKey) },
    { name: 'instruction', weight: 2, tokens: tokenSet(node.instruction) },
    {
      name: 'skill',
      weight: 3,
      tokens: tokenSet(node.skillLinks
        .map(link => `${link.skill.slug} ${link.skill.name} ${link.skill.summary}`)
        .join(' ')),
    },
  ];
  let weightedMatches = 0;
  const matchedQueryTokens = new Set<string>();
  const matchedOn: string[] = [];
  for (const field of fields) {
    let matches = 0;
    for (const token of queryWords) {
      if (!field.tokens.has(token)) continue;
      matches += 1;
      matchedQueryTokens.add(token);
    }
    if (matches > 0) {
      weightedMatches += matches * field.weight;
      matchedOn.push(field.name);
    }
  }
  const coverage = matchedQueryTokens.size / queryWords.size;
  let score = weightedMatches + coverage * 5;
  if (node.scopeKey === 'general') score *= 0.65;
  return { score, matchedOn };
}
