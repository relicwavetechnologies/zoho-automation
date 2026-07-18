import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

const MAX_UNDO_SNAPSHOTS = 2;

const snapshotNodeSchema = z.object({
  kind: z.enum(['preference', 'correction', 'workflow', 'skill', 'contradiction']),
  scopeKey: z.string().min(1),
  ruleKey: z.string().min(1),
  instruction: z.string(),
  confidence: z.number(),
  evidenceCount: z.number().int().nonnegative(),
  firstEvidenceAt: z.string().datetime(),
  lastEvidenceAt: z.string().datetime(),
  status: z.enum(['active', 'superseded', 'quarantined']),
  candidateIds: z.array(z.string()),
});

const personaSnapshotSchema = z.object({
  nodes: z.array(snapshotNodeSchema),
});

type RevisionTx = Pick<
  Prisma.TransactionClient,
  'managerPersonaTree' | 'managerPersonaNode' | 'managerPersonaRevision' | 'personaLearningCandidate'
>;

export class ManagerPersonaRevisionError extends Error {
  constructor(
    readonly code: 'not_manager' | 'persona_not_found' | 'no_undo_available' | 'persona_changed',
    message: string,
  ) {
    super(message);
    this.name = 'ManagerPersonaRevisionError';
  }
}

/**
 * Owns bounded persona snapshots and Undo. The live persona remains normalized
 * in ManagerPersonaNode; snapshots are never injected into runtime prompts.
 */
export class ManagerPersonaRevisionService {
  private readonly log: Logger;

  constructor(private readonly deps: { prisma: PrismaClient; logger: Logger }) {
    this.log = deps.logger.child({ service: 'manager-persona-revisions' });
  }

  async captureBeforeMutation(
    tx: RevisionTx,
    treeId: string,
    source: 'passive_learning' | 'teach',
    snapshotRevision?: number,
  ): Promise<void> {
    const tree = await tx.managerPersonaTree.findUnique({
      where: { id: treeId },
      include: {
        nodes: {
          include: { candidates: { select: { id: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!tree) throw new ManagerPersonaRevisionError('persona_not_found', 'Manager persona was not found');

    const snapshot = {
      nodes: tree.nodes.map(node => ({
        kind: node.kind,
        scopeKey: node.scopeKey,
        ruleKey: node.ruleKey,
        instruction: node.instruction,
        confidence: node.confidence,
        evidenceCount: node.evidenceCount,
        firstEvidenceAt: node.firstEvidenceAt.toISOString(),
        lastEvidenceAt: node.lastEvidenceAt.toISOString(),
        status: node.status,
        candidateIds: node.candidates.map(candidate => candidate.id),
      })),
    } satisfies z.infer<typeof personaSnapshotSchema>;

    await tx.managerPersonaRevision.upsert({
      where: { treeId_revision: { treeId, revision: snapshotRevision ?? tree.revision } },
      create: {
        treeId,
        revision: snapshotRevision ?? tree.revision,
        snapshotJson: snapshot,
        source,
      },
      update: { snapshotJson: snapshot, source },
    });

    const stale = await tx.managerPersonaRevision.findMany({
      where: { treeId },
      orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
      skip: MAX_UNDO_SNAPSHOTS,
      select: { id: true },
    });
    if (stale.length > 0) {
      await tx.managerPersonaRevision.deleteMany({
        where: { id: { in: stale.map(row => row.id) } },
      });
    }
  }

  async undo(input: { companyId: string; managerId: string; departmentId: string }) {
    await this.assertManager(input);

    const result = await this.deps.prisma.$transaction(async tx => {
      const tree = await tx.managerPersonaTree.findUnique({
        where: {
          companyId_managerId_departmentId: input,
        },
        select: { id: true, revision: true },
      });
      if (!tree) {
        throw new ManagerPersonaRevisionError('persona_not_found', 'No manager persona exists for this department');
      }

      const previous = await tx.managerPersonaRevision.findFirst({
        where: { treeId: tree.id },
        orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
      });
      if (!previous) {
        throw new ManagerPersonaRevisionError('no_undo_available', 'No earlier persona version is available');
      }

      const snapshot = personaSnapshotSchema.parse(previous.snapshotJson);
      const claimed = await tx.managerPersonaTree.updateMany({
        where: { id: tree.id, revision: tree.revision },
        data: { revision: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new ManagerPersonaRevisionError(
          'persona_changed',
          'The manager persona changed while Undo was running; please try again',
        );
      }

      const currentNodes = await tx.managerPersonaNode.findMany({
        where: { treeId: tree.id },
        select: { id: true },
      });
      if (currentNodes.length > 0) {
        await tx.personaLearningCandidate.updateMany({
          where: {
            promotedNodeId: { in: currentNodes.map(node => node.id) },
            status: 'active',
          },
          data: {
            status: 'reverted',
            promotedNodeId: null,
            promotedAt: null,
          },
        });
      }
      await tx.managerPersonaNode.deleteMany({ where: { treeId: tree.id } });

      for (const node of snapshot.nodes) {
        const restored = await tx.managerPersonaNode.create({
          data: {
            treeId: tree.id,
            companyId: input.companyId,
            managerId: input.managerId,
            departmentId: input.departmentId,
            kind: node.kind,
            scopeKey: node.scopeKey,
            ruleKey: node.ruleKey,
            instruction: node.instruction,
            confidence: node.confidence,
            evidenceCount: node.evidenceCount,
            firstEvidenceAt: new Date(node.firstEvidenceAt),
            lastEvidenceAt: new Date(node.lastEvidenceAt),
            status: node.status,
          },
          select: { id: true },
        });

        if (node.candidateIds.length > 0) {
          await tx.personaLearningCandidate.updateMany({
            where: {
              id: { in: node.candidateIds },
              companyId: input.companyId,
              managerId: input.managerId,
              departmentId: input.departmentId,
            },
            data: {
              status: 'active',
              promotedNodeId: restored.id,
              promotedAt: new Date(),
            },
          });
        }
      }

      await tx.managerPersonaRevision.delete({ where: { id: previous.id } });
      const remainingUndos = await tx.managerPersonaRevision.count({ where: { treeId: tree.id } });

      return {
        treeId: tree.id,
        revision: tree.revision + 1,
        restoredFromRevision: previous.revision,
        remainingUndos,
      };
    });

    this.log.info('manager-persona.undo.complete', {
      treeId: result.treeId,
      revision: result.revision,
      restoredFromRevision: result.restoredFromRevision,
      remainingUndos: result.remainingUndos,
    });
    return result;
  }

  private async assertManager(input: { companyId: string; managerId: string; departmentId: string }) {
    const membership = await this.deps.prisma.departmentMembership.findFirst({
      where: {
        departmentId: input.departmentId,
        userId: input.managerId,
        status: 'active',
        role: { slug: 'MANAGER' },
        department: { companyId: input.companyId, status: 'active' },
      },
      select: { id: true },
    });
    if (!membership) {
      throw new ManagerPersonaRevisionError('not_manager', 'Only an active department manager can undo this persona');
    }
  }
}

export const MANAGER_PERSONA_MAX_UNDOS = MAX_UNDO_SNAPSHOTS;
