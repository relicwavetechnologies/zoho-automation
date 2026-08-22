import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { isSafePublishedMemoryFact } from '../knowledge/knowledge-fact-safety';
import { ManagerPersonaRevisionService } from './manager-persona-revision.service';
import type {
  ManagerTeachPersonaChange,
  ManagerTeachPersonaEvidenceInput,
  ManagerTeachLearningPatch,
  ManagerTeachIgnoredLearning,
  ManagerTeachPersonaTarget,
} from './manager-teach-persona.types';

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    teachSessionId: z.string(),
    companyId: z.string(),
    departmentId: z.string(),
    managerId: z.string(),
    kind: z.enum(['recording', 'upload']),
  }),
  frames: z.array(z.object({
    sequence: z.number().int().positive(),
    ocr: z.object({
      ocrText: z.string(),
      caption: z.string(),
      uiElements: z.array(z.string()),
    }),
  })),
  transcript: z.object({
    segments: z.array(z.object({
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
      text: z.string(),
    })),
  }),
  warnings: z.array(z.string()),
});

const TEACH_WRITE_CONTRACT = {
  schemaVersion: 2,
  readiness: {
    requiredFields: [
      'classifications',
      'outcome',
      'whenToUse',
      'inputs',
      'expectedOutput',
      'decisionRules',
      'exceptions',
      'automationTrigger',
      'monitoringScope',
      'autonomyBoundary',
      'failureHandling',
      'clarificationAnswers',
      'unresolvedMaterialQuestions',
    ],
    nullableFields: [
      'inputs',
      'expectedOutput',
      'decisionRules',
      'exceptions',
      'automationTrigger',
      'monitoringScope',
      'autonomyBoundary',
      'failureHandling',
    ],
    rule: 'Include every readiness field. Use null, never omission or an empty string, when a nullable field genuinely does not apply.',
  },
  skillOperations: {
    rule: 'Return skills: []. Shared skill creation and updates use the governed knowledge review flow, never Teach direct writes.',
    allowed: [],
  },
  personaOperations: {
    create: 'Use operation=create with kind, scopeKey, and ruleKey for a genuinely new concept. Do not include target.',
    merge: 'Use operation=merge when refining the same rule without contradiction.',
    replace: 'Use operation=replace when new manager guidance changes or contradicts the prior rule.',
    retire: 'Use operation=retire only when the prior rule no longer applies and has no replacement.',
    existingTarget: 'For merge, replace, or retire, copy the full exact target { nodeId: existingPersona[].id, kind, scopeKey, ruleKey } from one existingPersona entry.',
    allowed: ['create', 'merge', 'replace', 'retire'],
  },
  evidence: 'Use only exact transcript:* and frame:* refs returned in this response. Every written item requires at least one transcript ref.',
  arrays: 'Always include skills, changes, and ignored as arrays, including [] when empty.',
  preflight: [
    'No upsert or add operations.',
    'skills is empty; Teach never bypasses shared-knowledge review.',
    'Every persona merge, replace, or retire has the full exact target object.',
    'Every readiness key is present; non-applicable nullable values are null, not empty strings.',
    'unresolvedMaterialQuestions is empty before applying.',
    'baseRevision and evidence refs exactly match this context response.',
  ],
} as const;

const unsafeAuthorityPattern = /\b(?:bypass|disable|ignore|skip|override|weaken)\b.{0,80}\b(?:approval|auth(?:entication|orization)?|permission|rbac|security|system|policy|instruction)\b|\b(?:approval|auth(?:entication|orization)?|permission|rbac|security|system|policy|instruction)\b.{0,80}\b(?:bypass|disable|ignore|skip|override|weaken)\b|\b(?:grant|elevate)\b.{0,50}\b(?:access|permission|role)\b/i;
const promptInjectionPattern = /\b(?:ignore|disregard|forget)\b.{0,60}\b(?:previous|prior|system|developer|instruction|prompt)\b/i;
const TEACH_LEARNING_TRANSACTION_MAX_WAIT_MS = 10_000;
const TEACH_LEARNING_TRANSACTION_TIMEOUT_MS = 30_000;

export interface ManagerTeachPersonaProcessResult {
  readonly sessionId: string;
  readonly status: 'completed';
  readonly understanding: string;
  readonly appliedChangeCount: number;
  readonly appliedPersonaChangeCount: number;
  readonly appliedSkillCount: number;
  readonly skills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly revision: number;
    readonly outcome: 'created' | 'updated';
  }[];
  readonly personaRevision: number | null;
  readonly remainingUndos: number;
}

export interface ManagerTeachAgentContext {
  readonly teachSessionId: string;
  readonly departmentId: string;
  readonly source: 'recording' | 'upload';
  readonly originalFileName: string | null;
  readonly writePolicy: {
    readonly minConfidence: number;
    readonly atomic: true;
  };
  readonly writeContract: typeof TEACH_WRITE_CONTRACT;
  readonly evidence: ManagerTeachPersonaEvidenceInput;
}

export class ManagerTeachPersonaProcessor {
  private readonly log: Logger;
  private readonly revisions: ManagerPersonaRevisionService;

  constructor(private readonly deps: {
    prisma: PrismaClient;
    logger: Logger;
    minConfidence: number;
    maxEvidenceBytes: number;
    maxInputChars: number;
    modelProvider: string;
    modelId: string;
  }) {
    this.log = deps.logger.child({ service: 'manager-teach-persona' });
    this.revisions = new ManagerPersonaRevisionService(deps);
  }

  async getContext(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    sessionId: string;
  }): Promise<ManagerTeachAgentContext> {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: {
        id: input.sessionId,
        companyId: input.companyId,
        managerId: input.managerId,
        departmentId: input.departmentId,
      },
      include: {
        artifacts: { where: { kind: 'evidence_manifest', status: 'available' }, take: 1 },
      },
    });
    if (!session) throw new Error('Teach session was not found');
    if (!['evidence_ready', 'agent_processing', 'completed'].includes(session.status)) {
      throw new Error('Teach evidence is not ready for the interactive agent');
    }
    await this.assertManager(session.companyId, session.managerId, session.departmentId);
    const loaded = await this.loadEvidence(session);
    await this.deps.prisma.managerTeachSession.updateMany({
      where: { id: session.id, status: 'evidence_ready', cancelRequestedAt: null },
      data: { status: 'agent_processing', progress: 80, attempts: { increment: 1 }, lastError: null },
    });
    return {
      teachSessionId: session.id,
      departmentId: session.departmentId,
      source: session.source,
      originalFileName: session.originalFileName,
      writePolicy: {
        minConfidence: this.deps.minConfidence,
        atomic: true,
      },
      writeContract: TEACH_WRITE_CONTRACT,
      evidence: loaded.evidence,
    };
  }

  async apply(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    sessionId: string;
    mutationKey: string;
    patch: ManagerTeachLearningPatch;
  }): Promise<ManagerTeachPersonaProcessResult> {
    const priorByKey = await this.deps.prisma.managerTeachSession.findUnique({
      where: { agentMutationKey: input.mutationKey },
      include: { personaMutation: true },
    });
    if (priorByKey) {
      if (
        priorByKey.companyId !== input.companyId
        || priorByKey.managerId !== input.managerId
        || priorByKey.departmentId !== input.departmentId
      ) {
        throw new Error('Teach mutation key belongs to another manager');
      }
      if (priorByKey.personaMutation) return this.toResult(priorByKey.personaMutation);
    }
    if (input.patch.skills.length > 0) {
      throw new Error(
        'Teach cannot write shared skills directly. Submit the exact skill through the governed knowledge review flow. The requester reviews it, then the backend resolves current department-manager authority; a current manager may confirm their own department skill when policy permits.',
      );
    }

    const rootSession = await this.deps.prisma.managerTeachSession.findFirst({
      where: {
        id: input.sessionId,
        companyId: input.companyId,
        managerId: input.managerId,
        departmentId: input.departmentId,
      },
      include: {
        personaMutation: true,
        artifacts: { where: { kind: 'evidence_manifest', status: 'available' }, take: 1 },
      },
    });
    if (!rootSession) throw new Error('Teach session was not found');
    if (!['evidence_ready', 'agent_processing', 'completed'].includes(rootSession.status)) {
      throw new Error('Teach session is not eligible for an interactive update');
    }
    await this.assertManager(rootSession.companyId, rootSession.managerId, rootSession.departmentId);
    const loaded = await this.loadEvidence(rootSession);
    if (input.patch.baseRevision !== loaded.evidence.baseRevision) {
      throw new Error('Manager persona changed; reload Teach context before writing');
    }
    const belowConfidenceThreshold = [
      ...input.patch.skills.map(skill => ({
        type: 'skill',
        key: skill.slug,
        confidence: skill.confidence,
      })),
      ...input.patch.changes.map(change => ({
        type: 'persona',
        key: change.operation === 'create' ? change.ruleKey : change.target.ruleKey,
        confidence: change.confidence,
      })),
    ].filter(item => item.confidence < this.deps.minConfidence);
    if (belowConfidenceThreshold.length > 0) {
      const rejected = belowConfidenceThreshold
        .map(item => `${item.type} "${item.key}" (${item.confidence.toFixed(2)})`)
        .join(', ');
      throw new Error(
        `Teach learning patch was not applied: ${rejected} is below the required confidence `
        + `${this.deps.minConfidence.toFixed(2)}. Clarify material uncertainty or omit the uncertain item, `
        + 'then reload Teach context and submit one corrected atomic patch. Do not inflate confidence.',
      );
    }
    const acceptedPersona = validateTeachPersonaChanges(
      input.patch.changes,
      loaded.evidence,
      loaded.nodes,
      this.deps.minConfidence,
    );
    const acceptedSkills: never[] = [];
    const acceptedIgnored = validateIgnoredTeachLearnings(input.patch.ignored, loaded.evidence, loaded.nodes);
    if (
      acceptedPersona.length !== input.patch.changes.length
      || acceptedIgnored.length !== input.patch.ignored.length
    ) {
      const acceptedPersonaSet = new Set(acceptedPersona);
      const rejected = [
        ...input.patch.changes
          .filter(change => !acceptedPersonaSet.has(change))
          .map(change => `persona "${change.operation === 'create' ? change.ruleKey : change.target.ruleKey}"`),
        ...input.patch.ignored
          .filter(ignored => !acceptedIgnored.includes(ignored))
          .map(ignored => `ignored concept "${ignored.conceptKey}"`),
      ].join(', ');
      throw new Error(
        `Teach learning patch was not applied: ${rejected} failed evidence, safety, duplication, or target validation. `
        + 'Reload Teach context and submit one corrected atomic patch.',
      );
    }
    const understanding = safeUnderstanding(
      input.patch.understanding,
      acceptedPersona.length + acceptedSkills.length > 0,
    );

    let targetSessionId = priorByKey?.id ?? rootSession.id;
    if (!priorByKey && rootSession.personaMutation) {
      const child = await this.deps.prisma.managerTeachSession.create({
        data: {
          companyId: rootSession.companyId,
          managerId: rootSession.managerId,
          departmentId: rootSession.departmentId,
          source: rootSession.source,
          status: 'agent_processing',
          progress: 90,
          originalFileName: rootSession.originalFileName,
          mimeType: rootSession.mimeType,
          fileSize: rootSession.fileSize,
          parentSessionId: rootSession.id,
          managerCorrection: understanding,
          agentMutationKey: input.mutationKey,
          startedAt: new Date(),
        },
      });
      targetSessionId = child.id;
    }

    const result = await this.deps.prisma.$transaction(async tx => {
        const prior = await tx.managerTeachPersonaMutation.findUnique({ where: { sessionId: targetSessionId } });
        if (prior) {
          const priorUndos = prior.treeId
            ? await tx.managerPersonaRevision.count({ where: { treeId: prior.treeId } })
            : 0;
          return this.toResult(prior, priorUndos);
        }

        const currentSession = await tx.managerTeachSession.findUnique({
          where: { id: targetSessionId },
          select: {
            id: true,
            companyId: true,
            managerId: true,
            departmentId: true,
            status: true,
            cancelRequestedAt: true,
          },
        });
        if (!currentSession || !['evidence_ready', 'agent_processing'].includes(currentSession.status) || currentSession.cancelRequestedAt) {
          throw new Error('Teach session is no longer eligible for an agent update');
        }
        const membership = await tx.departmentMembership.findFirst({
          where: {
            departmentId: currentSession.departmentId,
            userId: currentSession.managerId,
            status: 'active',
            role: { slug: 'MANAGER' },
            department: { companyId: currentSession.companyId, status: 'active' },
          },
          select: { id: true },
        });
        if (!membership) throw new Error('Manager authority changed before Teach could update the persona');

        const currentTree = await tx.managerPersonaTree.findUnique({
          where: {
            companyId_managerId_departmentId: {
              companyId: currentSession.companyId,
              managerId: currentSession.managerId,
              departmentId: currentSession.departmentId,
            },
          },
          include: { nodes: true },
        });
        const currentRevision = currentTree?.revision ?? 0;
        if (currentRevision !== input.patch.baseRevision) {
          throw new Error('Manager persona changed while Teach was being processed');
        }

        if (acceptedPersona.length === 0 && acceptedSkills.length === 0) {
          const mutation = await tx.managerTeachPersonaMutation.create({
            data: {
              sessionId: targetSessionId,
              treeId: currentTree?.id ?? null,
              baseRevision: currentRevision,
              appliedRevision: currentRevision || null,
              evidenceHash: loaded.evidenceHash,
              modelProvider: this.deps.modelProvider,
              modelId: this.deps.modelId,
              status: 'no_learning',
              understanding,
              patchJson: toJson({
                schemaVersion: 2,
                understanding,
                readiness: input.patch.readiness,
                skills: [],
                changes: [],
                ignored: acceptedIgnored,
              }),
              appliedChangeCount: 0,
            },
          });
          await tx.managerTeachSession.update({
            where: { id: targetSessionId },
            data: {
              status: 'completed', progress: 100, completedAt: new Date(), lastError: null,
              agentMutationKey: input.mutationKey,
            },
          });
          const remainingUndos = currentTree
            ? await tx.managerPersonaRevision.count({ where: { treeId: currentTree.id } })
            : 0;
          return this.toResult(mutation, remainingUndos);
        }

        const mutationTime = new Date();
        const appliedSkills: Array<{
          id: string;
          slug: string;
          name: string;
          revision: number;
          outcome: 'created' | 'updated';
        }> = [];
        const provenanceRows: Array<{
          personaNodeId?: string;
          skillId?: string;
          decision: 'create' | 'merge' | 'replace' | 'retire';
          evidenceRefs: string[];
          rationale: string;
          priorStateJson?: Prisma.InputJsonValue;
        }> = [];
        const referencedSkillSlugs = new Set<string>();
        for (const change of acceptedPersona) {
          if (change.operation === 'create') {
            change.skillSlugs.forEach(slug => referencedSkillSlugs.add(slug));
          } else if (change.operation === 'merge' || change.operation === 'replace') {
            change.skillSlugs?.forEach(slug => referencedSkillSlugs.add(slug));
          }
        }
        const referencedSkills = referencedSkillSlugs.size > 0
          ? await tx.skill.findMany({
            where: {
              companyId: currentSession.companyId,
              slug: { in: [...referencedSkillSlugs] },
              status: 'active',
              OR: [
                { scope: 'company', departmentId: null },
                { scope: 'department', departmentId: currentSession.departmentId },
              ],
            },
            orderBy: [{ revision: 'desc' }],
          })
          : [];
        const skillsBySlug = new Map<string, typeof referencedSkills[number]>();
        for (const skill of referencedSkills) {
          const current = skillsBySlug.get(skill.slug);
          if (!current || skill.departmentId === currentSession.departmentId) {
            skillsBySlug.set(skill.slug, skill);
          }
        }
        const missingSkillSlugs = [...referencedSkillSlugs].filter(slug => !skillsBySlug.has(slug));
        if (missingSkillSlugs.length > 0) {
          throw new Error(`Persona links reference unavailable skills: ${missingSkillSlugs.join(', ')}`);
        }

        let liveTree: { id: string; revision: number } | null = currentTree
          ? { id: currentTree.id, revision: currentTree.revision }
          : null;
        if (acceptedPersona.length > 0 && !currentTree) {
          liveTree = await tx.managerPersonaTree.create({
            data: {
              companyId: currentSession.companyId,
              managerId: currentSession.managerId,
              departmentId: currentSession.departmentId,
            },
            select: { id: true, revision: true },
          });
          await this.revisions.captureBeforeMutation(tx, liveTree.id, 'teach', 0);
        } else if (acceptedPersona.length > 0 && currentTree) {
          const revisionClaim = await tx.managerPersonaTree.updateMany({
            where: { id: currentTree.id, revision: currentTree.revision },
            data: { revision: { increment: 1 } },
          });
          if (revisionClaim.count === 0) {
            throw new Error('Manager persona changed while Teach was applying its update');
          }
          liveTree = { id: currentTree.id, revision: currentTree.revision + 1 };
          await this.revisions.captureBeforeMutation(tx, liveTree.id, 'teach', currentTree.revision);
        }

        const nodesById = new Map((currentTree?.nodes ?? []).map(node => [node.id, node]));
        for (const change of acceptedPersona) {
          if (!liveTree) throw new Error('Teach could not create the manager persona tree');
          if (change.operation === 'create') {
            const node = await tx.managerPersonaNode.create({
              data: {
                treeId: liveTree.id,
                companyId: currentSession.companyId,
                managerId: currentSession.managerId,
                departmentId: currentSession.departmentId,
                kind: change.kind,
                scopeKey: change.scopeKey,
                ruleKey: change.ruleKey,
                instruction: change.instruction,
                confidence: change.confidence,
                evidenceCount: change.evidenceRefs.length,
                firstEvidenceAt: mutationTime,
                lastEvidenceAt: mutationTime,
                status: 'active',
              },
            });
            await replaceNodeSkillLinks(tx, node.id, change.skillSlugs, skillsBySlug);
            nodesById.set(node.id, node);
            provenanceRows.push({
              personaNodeId: node.id,
              decision: 'create',
              evidenceRefs: [...change.evidenceRefs],
              rationale: change.rationale,
            });
            continue;
          }

          const target = nodesById.get(change.target.nodeId);
          if (!target) throw new Error('Teach persona target disappeared during application');
          if (targetKey(target) !== targetKey(change.target)) {
            throw new Error('Teach persona target identity changed during application');
          }
          const priorStateJson = toJson({
            kind: target.kind,
            scopeKey: target.scopeKey,
            ruleKey: target.ruleKey,
            instruction: target.instruction,
            confidence: target.confidence,
            evidenceCount: target.evidenceCount,
            firstEvidenceAt: target.firstEvidenceAt.toISOString(),
            lastEvidenceAt: target.lastEvidenceAt.toISOString(),
            status: target.status,
          });
          if (change.operation === 'merge' || change.operation === 'replace') {
            const updated = await tx.managerPersonaNode.update({
              where: { id: target.id },
              data: {
                instruction: change.instruction,
                confidence: change.operation === 'merge'
                  ? Math.max(target.confidence, change.confidence)
                  : change.confidence,
                evidenceCount: change.operation === 'merge'
                  ? target.evidenceCount + change.evidenceRefs.length
                  : change.evidenceRefs.length,
                ...(change.operation === 'replace' ? { firstEvidenceAt: mutationTime } : {}),
                lastEvidenceAt: mutationTime,
                status: 'active',
              },
            });
            if (change.skillSlugs !== undefined) {
              await replaceNodeSkillLinks(tx, updated.id, change.skillSlugs, skillsBySlug);
            }
            nodesById.set(updated.id, updated);
            provenanceRows.push({
              personaNodeId: updated.id,
              decision: change.operation,
              evidenceRefs: [...change.evidenceRefs],
              rationale: change.rationale,
              priorStateJson,
            });
          } else {
            const updated = await tx.managerPersonaNode.update({
              where: { id: target.id },
              data: {
                status: 'superseded',
                confidence: change.confidence,
                evidenceCount: change.evidenceRefs.length,
                lastEvidenceAt: mutationTime,
              },
            });
            nodesById.set(updated.id, updated);
            provenanceRows.push({
              personaNodeId: updated.id,
              decision: 'retire',
              evidenceRefs: [...change.evidenceRefs],
              rationale: change.rationale,
              priorStateJson,
            });
          }
        }

        const mutation = await tx.managerTeachPersonaMutation.create({
          data: {
            sessionId: targetSessionId,
            treeId: liveTree?.id ?? null,
            baseRevision: currentRevision,
            appliedRevision: (liveTree?.revision ?? currentRevision) || null,
            evidenceHash: loaded.evidenceHash,
            modelProvider: this.deps.modelProvider,
            modelId: this.deps.modelId,
            status: 'applied',
            understanding,
            patchJson: toJson({
              schemaVersion: 2,
              understanding,
              readiness: input.patch.readiness,
              skills: appliedSkills,
              changes: acceptedPersona,
              ignored: acceptedIgnored,
            }),
            appliedChangeCount: acceptedPersona.length + appliedSkills.length,
          },
        });
        if (provenanceRows.length > 0) {
          await tx.managerLearningProvenance.createMany({
            data: provenanceRows.map(row => ({
              teachSessionId: targetSessionId,
              mutationId: mutation.id,
              personaNodeId: row.personaNodeId ?? null,
              skillId: row.skillId ?? null,
              decision: row.decision,
              evidenceRefs: row.evidenceRefs,
              rationale: row.rationale,
              ...(row.priorStateJson !== undefined ? { priorStateJson: row.priorStateJson } : {}),
            })),
          });
        }
        await tx.managerTeachSession.update({
          where: { id: targetSessionId },
          data: {
            status: 'completed', progress: 100, completedAt: mutationTime, lastError: null,
            agentMutationKey: input.mutationKey,
          },
        });
        const remainingUndos = liveTree
          ? await tx.managerPersonaRevision.count({ where: { treeId: liveTree.id } })
          : 0;
        return this.toResult(mutation, remainingUndos);
      }, {
        maxWait: TEACH_LEARNING_TRANSACTION_MAX_WAIT_MS,
        timeout: TEACH_LEARNING_TRANSACTION_TIMEOUT_MS,
      });

    this.log.info('manager-teach.agent.learning_applied', {
      sessionId: targetSessionId,
      rootSessionId: rootSession.id,
      appliedChangeCount: result.appliedChangeCount,
      appliedSkillCount: result.appliedSkillCount,
      personaRevision: result.personaRevision,
    });
    return result;
  }

  private async loadEvidence(session: {
    id: string;
    companyId: string;
    managerId: string;
    departmentId: string;
    source: 'recording' | 'upload';
    artifacts: readonly { storageKey: string; sizeBytes: number }[];
  }): Promise<{
    evidenceHash: string;
    evidence: ManagerTeachPersonaEvidenceInput;
    nodes: readonly {
      id: string;
      kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
      scopeKey: string;
      ruleKey: string;
      instruction: string;
      confidence: number;
      evidenceCount: number;
      status: 'active' | 'superseded' | 'quarantined';
      skillLinks: readonly {
        skill: { id: string; slug: string; name: string; revision: number };
      }[];
    }[];
  }> {
    const artifact = session.artifacts[0];
    if (!artifact) throw new Error('Teach evidence manifest is missing');
    if (artifact.sizeBytes > this.deps.maxEvidenceBytes) {
      throw new Error('Teach evidence manifest exceeds the configured processing limit');
    }
    const bytes = await readFile(artifact.storageKey);
    if (bytes.byteLength !== artifact.sizeBytes || bytes.byteLength > this.deps.maxEvidenceBytes) {
      throw new Error('Teach evidence manifest failed integrity validation');
    }
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (
      manifest.source.teachSessionId !== session.id
      || manifest.source.companyId !== session.companyId
      || manifest.source.departmentId !== session.departmentId
      || manifest.source.managerId !== session.managerId
      || manifest.source.kind !== session.source
    ) {
      throw new Error('Teach evidence manifest does not belong to this session');
    }
    const tree = await this.deps.prisma.managerPersonaTree.findUnique({
      where: {
        companyId_managerId_departmentId: {
          companyId: session.companyId,
          managerId: session.managerId,
          departmentId: session.departmentId,
        },
      },
      include: {
        nodes: {
          include: {
            skillLinks: {
              include: { skill: { select: { id: true, slug: true, name: true, revision: true } } },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const existingSkills = await this.deps.prisma.skill.findMany({
      where: {
        companyId: session.companyId,
        departmentId: session.departmentId,
        scope: 'department',
        status: 'active',
      },
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      take: 100,
      select: {
        id: true,
        slug: true,
        name: true,
        summary: true,
        revision: true,
        toolIds: true,
        tags: true,
      },
    });
    return {
      evidenceHash: createHash('sha256').update(bytes).digest('hex'),
      evidence: buildBoundedTeachPersonaEvidence(
        manifest,
        tree?.revision ?? 0,
        tree?.nodes ?? [],
        existingSkills,
        this.deps.maxInputChars,
      ),
      nodes: tree?.nodes ?? [],
    };
  }

  private async assertManager(companyId: string, managerId: string, departmentId: string): Promise<void> {
    const membership = await this.deps.prisma.departmentMembership.findFirst({
      where: {
        departmentId,
        userId: managerId,
        status: 'active',
        role: { slug: 'MANAGER' },
        department: { companyId, status: 'active' },
      },
      select: { id: true },
    });
    if (!membership) throw new Error('Only an active department manager can use Teach');
  }

  private async toResult(
    mutation: {
      sessionId: string;
      treeId: string | null;
      status: 'applied' | 'no_learning';
      understanding: string;
      appliedChangeCount: number;
      appliedRevision: number | null;
      baseRevision: number | null;
      patchJson: unknown;
    },
    knownRemainingUndos?: number,
  ): Promise<ManagerTeachPersonaProcessResult> {
    const remainingUndos = knownRemainingUndos ?? (mutation.treeId
      ? await this.deps.prisma.managerPersonaRevision.count({ where: { treeId: mutation.treeId } })
      : 0);
    const skills = appliedSkillsFromPatch(mutation.patchJson);
    const personaChangeCount = appliedPersonaChangeCountFromPatch(mutation.patchJson);
    return {
      sessionId: mutation.sessionId,
      status: 'completed',
      understanding: mutation.understanding,
      appliedChangeCount: mutation.appliedChangeCount,
      appliedPersonaChangeCount: personaChangeCount,
      appliedSkillCount: skills.length,
      skills,
      personaRevision: mutation.appliedRevision ?? mutation.baseRevision,
      remainingUndos,
    };
  }
}

export function buildBoundedTeachPersonaEvidence(
  manifest: z.infer<typeof manifestSchema>,
  baseRevision: number,
  nodes: readonly {
    id: string;
    kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
    scopeKey: string;
    ruleKey: string;
    instruction: string;
    confidence: number;
    evidenceCount: number;
    status: 'active' | 'superseded' | 'quarantined';
    skillLinks?: readonly {
      skill: { id: string; slug: string; name: string; revision: number };
    }[];
  }[],
  skills: readonly {
    id: string;
    slug: string;
    name: string;
    summary: string;
    revision: number;
    toolIds: readonly string[];
    tags: readonly string[];
  }[],
  maxChars: number,
): ManagerTeachPersonaEvidenceInput {
  const limit = Math.max(1_000, maxChars);
  const existingPersona: ManagerTeachPersonaEvidenceInput['existingPersona'][number][] = [];
  const personaBudget = Math.floor(limit * 0.2);
  let personaUsed = 0;
  for (const node of nodes.slice(0, 500)) {
    const item = {
      id: node.id,
      kind: node.kind,
      scopeKey: node.scopeKey,
      ruleKey: node.ruleKey,
      instruction: node.instruction.slice(0, 1_000),
      confidence: node.confidence,
      evidenceCount: node.evidenceCount,
      status: node.status,
      linkedSkills: (node.skillLinks ?? []).map(link => link.skill),
    };
    const cost = JSON.stringify(item).length;
    if (personaUsed + cost > personaBudget) break;
    existingPersona.push(item);
    personaUsed += cost;
  }
  const existingSkills: ManagerTeachPersonaEvidenceInput['existingSkills'][number][] = [];
  const skillsBudget = Math.floor(limit * 0.15);
  let skillsUsed = 0;
  for (const skill of skills) {
    const item = {
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      summary: skill.summary.slice(0, 1_024),
      revision: skill.revision,
      toolIds: [...skill.toolIds],
      tags: [...skill.tags],
    };
    const cost = JSON.stringify(item).length;
    if (skillsUsed + cost > skillsBudget) break;
    existingSkills.push(item);
    skillsUsed += cost;
  }
  const warnings = manifest.warnings.slice(0, 20).map(warning => warning.slice(0, 500));
  let remaining = Math.max(0, limit - personaUsed - skillsUsed - JSON.stringify(warnings).length - 1_000);
  const transcriptBudget = Math.floor(remaining * 0.65);
  let transcriptUsed = 0;
  const transcript: ManagerTeachPersonaEvidenceInput['transcript'][number][] = [];
  for (const [index, segment] of manifest.transcript.segments.entries()) {
    const text = segment.text.trim().slice(0, 6_000);
    if (!text) continue;
    const cost = text.length + 100;
    if (transcriptUsed + cost > transcriptBudget) break;
    transcript.push({ ref: `transcript:${index + 1}`, start: segment.start, end: segment.end, text });
    transcriptUsed += cost;
  }
  remaining -= transcriptUsed;

  const frames: ManagerTeachPersonaEvidenceInput['frames'][number][] = [];
  for (const frame of manifest.frames) {
    const item = {
      ref: `frame:${frame.sequence}`,
      caption: frame.ocr.caption.trim().slice(0, 1_000),
      ocrText: frame.ocr.ocrText.trim().slice(0, 6_000),
      uiElements: frame.ocr.uiElements.slice(0, 50).map(element => element.slice(0, 200)),
    };
    const cost = JSON.stringify(item).length;
    if (cost > remaining) break;
    frames.push(item);
    remaining -= cost;
  }

  return { baseRevision, existingPersona, existingSkills, transcript, frames, warnings };
}

export function validateTeachPersonaChanges(
  changes: readonly ManagerTeachPersonaChange[],
  evidence: ManagerTeachPersonaEvidenceInput,
  nodes: readonly {
    id: string;
    kind: string;
    scopeKey: string;
    ruleKey: string;
    instruction: string;
    status: string;
  }[],
  minConfidence: number,
): ManagerTeachPersonaChange[] {
  const availableRefs = new Set([
    ...evidence.transcript.map(item => item.ref),
    ...evidence.frames.map(item => item.ref),
  ]);
  const existingByKey = new Map(nodes.map(node => [targetKey(node), node]));
  const existingById = new Map(nodes.map(node => [node.id, node]));
  const usedTargets = new Set<string>();
  const accepted: ManagerTeachPersonaChange[] = [];

  for (const change of changes) {
    if (change.confidence < minConfidence) continue;
    if (change.evidenceRefs.some(ref => !availableRefs.has(ref))) continue;
    if (!change.evidenceRefs.some(ref => ref.startsWith('transcript:'))) continue;
    if (!isSafePersonaText(change.rationale)) continue;

    if (change.operation === 'create') {
      const key = targetKey(change);
      if (existingByKey.has(key) || usedTargets.has(key) || !isSafePersonaText(change.instruction)) continue;
      const duplicate = nodes.some(node => node.status === 'active'
        && node.kind === change.kind
        && isLikelyDuplicate(
          [change.scopeKey, change.ruleKey, change.instruction].join(' '),
          [node.scopeKey, node.ruleKey, node.instruction].join(' '),
          0.9,
        ));
      if (duplicate) continue;
      usedTargets.add(key);
      accepted.push(change);
      continue;
    }

    const key = targetKey(change.target);
    const target = existingById.get(change.target.nodeId);
    if (
      !target
      || targetKey(target) !== key
      || target.status !== 'active'
      || usedTargets.has(target.id)
    ) continue;
    if (change.operation !== 'retire' && !isSafePersonaText(change.instruction)) continue;
    if (
      change.operation === 'replace'
      && normalizeComparableText(change.instruction) === normalizeComparableText(target.instruction)
    ) continue;
    usedTargets.add(target.id);
    accepted.push(change);
  }
  return accepted;
}

export function validateIgnoredTeachLearnings(
  ignored: readonly ManagerTeachIgnoredLearning[],
  evidence: ManagerTeachPersonaEvidenceInput,
  nodes: readonly { id: string; kind: string; scopeKey: string; ruleKey: string }[],
): ManagerTeachIgnoredLearning[] {
  const availableRefs = new Set([
    ...evidence.transcript.map(item => item.ref),
    ...evidence.frames.map(item => item.ref),
  ]);
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  return ignored.filter(item => {
    if (seen.has(item.conceptKey) || !isSafePersonaText(item.reason)) return false;
    if (item.evidenceRefs.some(ref => !availableRefs.has(ref))) return false;
    if (item.matchedTarget) {
      const target = nodesById.get(item.matchedTarget.nodeId);
      if (!target || targetKey(target) !== targetKey(item.matchedTarget)) return false;
    }
    seen.add(item.conceptKey);
    return true;
  });
}

const canonicalStopWords = new Set([
  'and', 'are', 'for', 'from', 'into', 'that', 'the', 'their', 'then', 'this', 'use', 'when', 'with',
]);

function normalizeComparableText(value: string): string {
  return [...canonicalTokenSet(value)].sort().join(' ');
}

function canonicalTokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !canonicalStopWords.has(token)));
}

function isLikelyDuplicate(left: string, right: string, threshold: number): boolean {
  const leftTokens = canonicalTokenSet(left);
  const rightTokens = canonicalTokenSet(right);
  if (Math.min(leftTokens.size, rightTokens.size) < 4) return false;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const dice = (2 * intersection) / (leftTokens.size + rightTokens.size);
  return dice >= threshold;
}

function isSafePersonaText(text: string): boolean {
  return isSafePublishedMemoryFact(text)
    && !unsafeAuthorityPattern.test(text)
    && !promptInjectionPattern.test(text);
}

function safeUnderstanding(understanding: string, applied: boolean): string {
  if (isSafePersonaText(understanding)) return understanding;
  return applied
    ? 'Divo learned durable working guidance from this teaching.'
    : 'Divo reviewed the teaching but found no safe, high-confidence persona update.';
}

function targetKey(target: ManagerTeachPersonaTarget | { kind: string; scopeKey: string; ruleKey: string }): string {
  return [target.kind, target.scopeKey, target.ruleKey].join('\u0000');
}

async function replaceNodeSkillLinks(
  tx: Pick<Prisma.TransactionClient, 'managerPersonaSkillLink'>,
  personaNodeId: string,
  skillSlugs: readonly string[],
  skillsBySlug: ReadonlyMap<string, { id: string }>,
): Promise<void> {
  await tx.managerPersonaSkillLink.deleteMany({ where: { personaNodeId } });
  if (skillSlugs.length === 0) return;
  await tx.managerPersonaSkillLink.createMany({
    data: skillSlugs.map(slug => ({
      personaNodeId,
      skillId: skillsBySlug.get(slug)!.id,
    })),
    skipDuplicates: true,
  });
}

function appliedSkillsFromPatch(value: unknown): ManagerTeachPersonaProcessResult['skills'] {
  if (!value || typeof value !== 'object') return [];
  const skills = (value as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const skill = item as Record<string, unknown>;
    if (
      typeof skill.id !== 'string'
      || typeof skill.slug !== 'string'
      || typeof skill.name !== 'string'
      || typeof skill.revision !== 'number'
      || !['created', 'updated'].includes(String(skill.outcome))
    ) return [];
    return [{
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      revision: skill.revision,
      outcome: skill.outcome as 'created' | 'updated',
    }];
  });
}

function appliedPersonaChangeCountFromPatch(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const changes = (value as { changes?: unknown }).changes;
  return Array.isArray(changes) ? changes.length : 0;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
