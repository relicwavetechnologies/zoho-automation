import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { isSafePublishedMemoryFact } from '../memory/memory-fact-safety';
import { ManagerPersonaRevisionService } from './manager-persona-revision.service';
import type {
  ManagerTeachPersonaChange,
  ManagerTeachPersonaEvidenceInput,
  ManagerTeachPersonaPatch,
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

const unsafeAuthorityPattern = /\b(?:bypass|disable|ignore|skip|override|weaken)\b.{0,80}\b(?:approval|auth(?:entication|orization)?|permission|rbac|security|system|policy|instruction)\b|\b(?:approval|auth(?:entication|orization)?|permission|rbac|security|system|policy|instruction)\b.{0,80}\b(?:bypass|disable|ignore|skip|override|weaken)\b|\b(?:grant|elevate)\b.{0,50}\b(?:access|permission|role)\b/i;
const promptInjectionPattern = /\b(?:ignore|disregard|forget)\b.{0,60}\b(?:previous|prior|system|developer|instruction|prompt)\b/i;

export interface ManagerTeachPersonaProcessResult {
  readonly sessionId: string;
  readonly status: 'completed';
  readonly understanding: string;
  readonly appliedChangeCount: number;
  readonly personaRevision: number | null;
  readonly remainingUndos: number;
}

export interface ManagerTeachAgentContext {
  readonly teachSessionId: string;
  readonly departmentId: string;
  readonly source: 'recording' | 'upload';
  readonly originalFileName: string | null;
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
      evidence: loaded.evidence,
    };
  }

  async apply(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    sessionId: string;
    mutationKey: string;
    patch: ManagerTeachPersonaPatch;
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
    const accepted = validateTeachPersonaChanges(
      input.patch.changes,
      loaded.evidence,
      loaded.nodes,
      this.deps.minConfidence,
    );
    const understanding = safeUnderstanding(input.patch.understanding, accepted.length > 0);

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

        if (accepted.length === 0) {
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
              patchJson: toJson({ schemaVersion: 1, changes: [] }),
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
        let liveTree: { id: string; revision: number };
        if (!currentTree) {
          liveTree = await tx.managerPersonaTree.create({
            data: {
              companyId: currentSession.companyId,
              managerId: currentSession.managerId,
              departmentId: currentSession.departmentId,
            },
            select: { id: true, revision: true },
          });
          await this.revisions.captureBeforeMutation(tx, liveTree.id, 'teach', 0);
        } else {
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

        const nodesByTarget = new Map(
          (currentTree?.nodes ?? []).map(node => [targetKey(node), node]),
        );
        for (const change of accepted) {
          if (change.operation === 'add') {
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
            nodesByTarget.set(targetKey(change), node);
            continue;
          }

          const target = nodesByTarget.get(targetKey(change.target));
          if (!target) throw new Error('Teach persona target disappeared during application');
          if (change.operation === 'replace') {
            const updated = await tx.managerPersonaNode.update({
              where: { id: target.id },
              data: {
                instruction: change.instruction,
                confidence: change.confidence,
                evidenceCount: change.evidenceRefs.length,
                lastEvidenceAt: mutationTime,
                status: 'active',
              },
            });
            nodesByTarget.set(targetKey(change.target), updated);
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
            nodesByTarget.set(targetKey(change.target), updated);
          }
        }

        const mutation = await tx.managerTeachPersonaMutation.create({
          data: {
            sessionId: targetSessionId,
            treeId: liveTree.id,
            baseRevision: currentRevision,
            appliedRevision: liveTree.revision,
            evidenceHash: loaded.evidenceHash,
            modelProvider: this.deps.modelProvider,
            modelId: this.deps.modelId,
            status: 'applied',
            understanding,
            patchJson: toJson({ schemaVersion: 1, changes: accepted }),
            appliedChangeCount: accepted.length,
          },
        });
        await tx.managerTeachSession.update({
          where: { id: targetSessionId },
          data: {
            status: 'completed', progress: 100, completedAt: mutationTime, lastError: null,
            agentMutationKey: input.mutationKey,
          },
        });
        const remainingUndos = await tx.managerPersonaRevision.count({ where: { treeId: liveTree.id } });
        return this.toResult(mutation, remainingUndos);
      });

    this.log.info('manager-teach.agent.persona_applied', {
      sessionId: targetSessionId,
      rootSessionId: rootSession.id,
      appliedChangeCount: result.appliedChangeCount,
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
      kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
      scopeKey: string;
      ruleKey: string;
      instruction: string;
      status: 'active' | 'superseded' | 'quarantined';
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
      include: { nodes: { orderBy: { createdAt: 'asc' } } },
    });
    return {
      evidenceHash: createHash('sha256').update(bytes).digest('hex'),
      evidence: buildBoundedTeachPersonaEvidence(
        manifest,
        tree?.revision ?? 0,
        tree?.nodes ?? [],
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
    },
    knownRemainingUndos?: number,
  ): Promise<ManagerTeachPersonaProcessResult> {
    const remainingUndos = knownRemainingUndos ?? (mutation.treeId
      ? await this.deps.prisma.managerPersonaRevision.count({ where: { treeId: mutation.treeId } })
      : 0);
    return {
      sessionId: mutation.sessionId,
      status: 'completed',
      understanding: mutation.understanding,
      appliedChangeCount: mutation.appliedChangeCount,
      personaRevision: mutation.appliedRevision ?? mutation.baseRevision,
      remainingUndos,
    };
  }
}

export function buildBoundedTeachPersonaEvidence(
  manifest: z.infer<typeof manifestSchema>,
  baseRevision: number,
  nodes: readonly {
    kind: 'preference' | 'correction' | 'workflow' | 'skill' | 'contradiction';
    scopeKey: string;
    ruleKey: string;
    instruction: string;
    status: 'active' | 'superseded' | 'quarantined';
  }[],
  maxChars: number,
): ManagerTeachPersonaEvidenceInput {
  const limit = Math.max(1_000, maxChars);
  const existingPersona: ManagerTeachPersonaEvidenceInput['existingPersona'][number][] = [];
  const personaBudget = Math.floor(limit * 0.2);
  let personaUsed = 0;
  for (const node of nodes.slice(0, 500)) {
    const item = {
      kind: node.kind,
      scopeKey: node.scopeKey,
      ruleKey: node.ruleKey,
      instruction: node.instruction.slice(0, 1_000),
      status: node.status,
    };
    const cost = JSON.stringify(item).length;
    if (personaUsed + cost > personaBudget) break;
    existingPersona.push(item);
    personaUsed += cost;
  }
  const warnings = manifest.warnings.slice(0, 20).map(warning => warning.slice(0, 500));
  let remaining = Math.max(0, limit - personaUsed - JSON.stringify(warnings).length - 1_000);
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

  return { baseRevision, existingPersona, transcript, frames, warnings };
}

export function validateTeachPersonaChanges(
  changes: readonly ManagerTeachPersonaChange[],
  evidence: ManagerTeachPersonaEvidenceInput,
  nodes: readonly {
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
  const existing = new Map(nodes.map(node => [targetKey(node), node]));
  const usedTargets = new Set<string>();
  const accepted: ManagerTeachPersonaChange[] = [];

  for (const change of changes) {
    if (change.confidence < minConfidence) continue;
    if (change.evidenceRefs.some(ref => !availableRefs.has(ref))) continue;
    if (!change.evidenceRefs.some(ref => ref.startsWith('transcript:'))) continue;
    if (!isSafePersonaText(change.rationale)) continue;

    if (change.operation === 'add') {
      const key = targetKey(change);
      if (existing.has(key) || usedTargets.has(key) || !isSafePersonaText(change.instruction)) continue;
      existing.set(key, { ...change, status: 'active' });
      usedTargets.add(key);
      accepted.push(change);
      continue;
    }

    const key = targetKey(change.target);
    const target = existing.get(key);
    if (!target || target.status !== 'active' || usedTargets.has(key)) continue;
    if (change.operation === 'replace' && !isSafePersonaText(change.instruction)) continue;
    usedTargets.add(key);
    if (change.operation === 'retire') existing.set(key, { ...target, status: 'superseded' });
    accepted.push(change);
  }
  return accepted;
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

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
