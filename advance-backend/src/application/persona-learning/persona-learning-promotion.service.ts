import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { isSafePublishedMemoryFact } from '../memory/memory-fact-safety';
import { ManagerPersonaRevisionService } from './manager-persona-revision.service';

const MIN_NARROW_RULE_SUPPORT = 2;
const MIN_BROAD_OR_PROCEDURAL_RULE_SUPPORT = 3;

class PersonaPromotionRaceError extends Error {}

export interface PersonaPromotionCandidate {
  readonly id: string;
  readonly companyId: string;
  readonly managerId: string;
  readonly departmentId: string;
  readonly kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
  readonly scopeKey: string;
  readonly ruleKey: string;
  readonly claim: string;
  readonly rationale: string;
  readonly evidenceStrength: 'explicit' | 'confirmed' | 'inferred';
  readonly evidence: {
    readonly executionRunId: string;
    readonly capturedAt: Date;
  };
}

export interface PersonaPromotionDecision {
  readonly promote: boolean;
  readonly reason: string;
  readonly supportCount: number;
  readonly confidence?: number;
}

export interface PersonaLearningPromotionServiceDeps {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
}

/**
 * Deterministic authority gate between shadow model observations and active
 * manager persona. The extraction model never decides promotion itself.
 */
export class PersonaLearningPromotionService {
  private readonly log: Logger;
  private readonly revisions: ManagerPersonaRevisionService;

  constructor(private readonly deps: PersonaLearningPromotionServiceDeps) {
    this.log = deps.logger.child({ service: 'persona-learning-promotion' });
    this.revisions = new ManagerPersonaRevisionService(deps);
  }

  async promoteEligibleCandidates(limit = 100): Promise<number> {
    const pending = await this.deps.prisma.personaLearningCandidate.findMany({
      where: { status: 'shadow', ruleKey: { not: '' } },
      include: {
        evidence: {
          select: { executionRunId: true, capturedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const groups = groupPromotionCandidates(pending);
    let promoted = 0;

    for (const candidates of groups.values()) {
      const decision = decideAutomaticPromotion(candidates);
      if (!decision.promote) continue;
      const canonical = candidates.find(candidate => candidate.evidenceStrength === 'explicit');
      if (!canonical || decision.confidence === undefined) continue;
      const confidence = decision.confidence;

      let changed = false;
      try {
        changed = await this.deps.prisma.$transaction(async tx => {
          const tree = await tx.managerPersonaTree.upsert({
            where: {
              companyId_managerId_departmentId: {
                companyId: canonical.companyId,
                managerId: canonical.managerId,
                departmentId: canonical.departmentId,
              },
            },
            create: {
              companyId: canonical.companyId,
              managerId: canonical.managerId,
              departmentId: canonical.departmentId,
            },
            update: {},
          });
          const existing = await tx.managerPersonaNode.findUnique({
            where: {
              treeId_kind_scopeKey_ruleKey: {
                treeId: tree.id,
                kind: canonical.kind,
                scopeKey: canonical.scopeKey,
                ruleKey: canonical.ruleKey,
              },
            },
            select: { id: true, status: true },
          });

          // Passive learning never resolves contradictions autonomously. They
          // remain shadow evidence until an explicit Teach clarification can
          // merge, replace, or retire the canonical rule.
          if (existing?.status === 'quarantined' || existing?.status === 'superseded') return false;
          if (!existing) {
            const claimedTree = await tx.managerPersonaTree.updateMany({
              where: { id: tree.id, revision: tree.revision },
              data: { revision: { increment: 1 } },
            });
            if (claimedTree.count === 0) return false;
            await this.revisions.captureBeforeMutation(tx, tree.id, 'passive_learning', tree.revision);
          }
          const node = existing ?? await tx.managerPersonaNode.create({
            data: {
              treeId: tree.id,
              companyId: canonical.companyId,
              managerId: canonical.managerId,
              departmentId: canonical.departmentId,
              kind: canonical.kind,
              scopeKey: canonical.scopeKey,
              ruleKey: canonical.ruleKey,
              instruction: canonical.claim,
              confidence,
              evidenceCount: decision.supportCount,
              firstEvidenceAt: candidates[0]!.evidence.capturedAt,
              lastEvidenceAt: candidates.at(-1)!.evidence.capturedAt,
              status: 'active',
            },
          });
          const linked = await tx.personaLearningCandidate.updateMany({
            where: { id: { in: candidates.map(candidate => candidate.id) }, status: 'shadow' },
            data: { status: 'active', promotedNodeId: node.id, promotedAt: new Date() },
          });
          if (!existing && linked.count === 0) throw new PersonaPromotionRaceError();
          return linked.count > 0;
        });
      } catch (error) {
        if (error instanceof PersonaPromotionRaceError) continue;
        throw error;
      }
      if (changed) promoted += 1;
    }

    if (promoted > 0) {
      this.log.info('persona-learning.promotion.complete', { promoted, pending: pending.length });
    }
    return promoted;
  }
}

/** Pure gate: keep its rules reviewable and independently unit-testable. */
export function decideAutomaticPromotion(
  candidates: readonly PersonaPromotionCandidate[],
): PersonaPromotionDecision {
  const first = candidates[0];
  if (!first) return { promote: false, reason: 'no_candidates', supportCount: 0 };
  if (first.kind === 'contradiction') {
    return { promote: false, reason: 'contradiction_requires_resolution', supportCount: 0 };
  }
  if (!first.ruleKey || candidates.some(candidate =>
    candidate.kind !== first.kind
    || candidate.scopeKey !== first.scopeKey
    || candidate.ruleKey !== first.ruleKey
    || candidate.companyId !== first.companyId
    || candidate.managerId !== first.managerId
    || candidate.departmentId !== first.departmentId,
  )) {
    return { promote: false, reason: 'inconsistent_candidate_group', supportCount: 0 };
  }
  if (candidates.some(candidate => !isSafePublishedMemoryFact(`${candidate.claim}\n${candidate.rationale}`))) {
    return { promote: false, reason: 'credential_like_content', supportCount: 0 };
  }

  const explicit = candidates.filter(candidate => candidate.evidenceStrength === 'explicit');
  const distinctRuns = new Set(explicit.map(candidate => candidate.evidence.executionRunId)).size;
  const requiredSupport = isBroadOrProcedural(first)
    ? MIN_BROAD_OR_PROCEDURAL_RULE_SUPPORT
    : MIN_NARROW_RULE_SUPPORT;
  if (distinctRuns < requiredSupport) {
    return { promote: false, reason: 'insufficient_independent_explicit_evidence', supportCount: distinctRuns };
  }

  return {
    promote: true,
    reason: 'independent_explicit_manager_evidence',
    supportCount: distinctRuns,
    confidence: distinctRuns >= 4 ? 0.99 : requiredSupport === 3 ? 0.97 : 0.94,
  };
}

function groupPromotionCandidates(
  candidates: readonly PersonaPromotionCandidate[],
): Map<string, PersonaPromotionCandidate[]> {
  const groups = new Map<string, PersonaPromotionCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.companyId,
      candidate.managerId,
      candidate.departmentId,
      candidate.kind,
      candidate.scopeKey,
      candidate.ruleKey,
    ].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

function isBroadOrProcedural(candidate: PersonaPromotionCandidate): boolean {
  return candidate.scopeKey === 'general' || candidate.kind === 'skill';
}
