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
  ManagerTeachPersonaExtractor,
  ManagerTeachPersonaTarget,
} from './manager-teach-persona.extractor';

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
  readonly status: 'persona_updated' | 'no_learning';
  readonly understanding: string;
  readonly appliedChangeCount: number;
  readonly personaRevision: number | null;
  readonly remainingUndos: number;
}

export class ManagerTeachPersonaProcessor {
  private readonly log: Logger;
  private readonly revisions: ManagerPersonaRevisionService;

  constructor(private readonly deps: {
    prisma: PrismaClient;
    extractor: ManagerTeachPersonaExtractor;
    logger: Logger;
    minConfidence: number;
    maxEvidenceBytes: number;
    maxInputChars: number;
  }) {
    this.log = deps.logger.child({ service: 'manager-teach-persona' });
    this.revisions = new ManagerPersonaRevisionService(deps);
  }

  async process(sessionId: string): Promise<ManagerTeachPersonaProcessResult | null> {
    const existing = await this.deps.prisma.managerTeachPersonaMutation.findUnique({
      where: { sessionId },
    });
    if (existing) return this.toResult(existing);

    const claimed = await this.deps.prisma.managerTeachSession.updateMany({
      // A stalled BullMQ retry may find the session left in this state after a
      // process crash. The mutation uniqueness gate keeps the restart safe.
      where: {
        id: sessionId,
        status: { in: ['ready_for_processing', 'persona_processing'] },
        cancelRequestedAt: null,
      },
      data: {
        status: 'persona_processing',
        progress: 80,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count === 0) return null;

    try {
      const session = await this.deps.prisma.managerTeachSession.findUnique({
        where: { id: sessionId },
        include: {
          artifacts: { where: { kind: 'evidence_manifest', status: 'available' }, take: 1 },
        },
      });
      const artifact = session?.artifacts[0];
      if (!session || !artifact) throw new Error('Teach evidence manifest is missing');
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

      const evidenceHash = createHash('sha256').update(bytes).digest('hex');
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
      const evidence = buildBoundedTeachPersonaEvidence(
        manifest,
        tree?.revision ?? 0,
        tree?.nodes ?? [],
        this.deps.maxInputChars,
      );
      const patch = await this.deps.extractor.extract(evidence);
      if (patch.baseRevision !== evidence.baseRevision) {
        throw new Error('Teach persona editor returned a stale base revision');
      }

      const accepted = validateTeachPersonaChanges(
        patch.changes,
        evidence,
        tree?.nodes ?? [],
        this.deps.minConfidence,
      );
      const understanding = safeUnderstanding(patch.understanding, accepted.length > 0);

      const result = await this.deps.prisma.$transaction(async tx => {
        const prior = await tx.managerTeachPersonaMutation.findUnique({ where: { sessionId } });
        if (prior) {
          const priorUndos = prior.treeId
            ? await tx.managerPersonaRevision.count({ where: { treeId: prior.treeId } })
            : 0;
          return this.toResult(prior, priorUndos);
        }

        const currentSession = await tx.managerTeachSession.findUnique({
          where: { id: sessionId },
          select: {
            id: true,
            companyId: true,
            managerId: true,
            departmentId: true,
            status: true,
            cancelRequestedAt: true,
          },
        });
        if (!currentSession || currentSession.status !== 'persona_processing' || currentSession.cancelRequestedAt) {
          throw new Error('Teach session is no longer eligible for persona processing');
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
        if (currentRevision !== patch.baseRevision) {
          throw new Error('Manager persona changed while Teach was being processed');
        }

        if (accepted.length === 0) {
          const mutation = await tx.managerTeachPersonaMutation.create({
            data: {
              sessionId,
              treeId: currentTree?.id ?? null,
              baseRevision: currentRevision,
              appliedRevision: currentRevision || null,
              evidenceHash,
              modelProvider: this.deps.extractor.provider,
              modelId: this.deps.extractor.modelId,
              status: 'no_learning',
              understanding,
              patchJson: toJson({ schemaVersion: 1, changes: [] }),
              appliedChangeCount: 0,
            },
          });
          await tx.managerTeachSession.update({
            where: { id: sessionId },
            data: { status: 'no_learning', progress: 100, completedAt: new Date(), lastError: null },
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
            sessionId,
            treeId: liveTree.id,
            baseRevision: currentRevision,
            appliedRevision: liveTree.revision,
            evidenceHash,
            modelProvider: this.deps.extractor.provider,
            modelId: this.deps.extractor.modelId,
            status: 'applied',
            understanding,
            patchJson: toJson({ schemaVersion: 1, changes: accepted }),
            appliedChangeCount: accepted.length,
          },
        });
        await tx.managerTeachSession.update({
          where: { id: sessionId },
          data: { status: 'persona_updated', progress: 100, completedAt: mutationTime, lastError: null },
        });
        const remainingUndos = await tx.managerPersonaRevision.count({ where: { treeId: liveTree.id } });
        return this.toResult(mutation, remainingUndos);
      });

      this.log.info('manager-teach.persona.complete', {
        sessionId,
        status: result.status,
        appliedChangeCount: result.appliedChangeCount,
        personaRevision: result.personaRevision,
      });
      return result;
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.deps.prisma.managerTeachSession.updateMany({
        where: { id: sessionId, status: 'persona_processing', cancelRequestedAt: null },
        data: { status: 'ready_for_processing', progress: 75, lastError: message },
      });
      throw error;
    }
  }

  private async toResult(
    mutation: {
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
      status: mutation.status === 'applied' ? 'persona_updated' : 'no_learning',
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

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 2_000);
}
