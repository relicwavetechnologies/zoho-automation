/**
 * Canonical memory browser.
 *
 * Reads come from versioned Postgres knowledge resources. This route never
 * writes Hindsight: shared and personal deletes must pass the same knowledge
 * mutation, RBAC, review, approval, and outbox flow as every other channel.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { KnowledgeOperationsService } from '../../application/knowledge/knowledge-operations.service';
import type { AuditService } from '../../application/observability/audit.service';

export interface MemoryRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  operations: Pick<
    KnowledgeOperationsService,
    'health' | 'listFailedProjections' | 'retryFailedProjection'
  >;
  audit?: Pick<AuditService, 'record'>;
}

const listQuerySchema = z.object({
  // Personal content is private to its owner and is never exposed in the
  // company administration browser. Only aggregate personal counts are shown.
  scope: z.enum(['department', 'company']).optional(),
  departmentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();
const projectionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const projectionIdSchema = z.string().uuid();

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

function companyIdFor(res: Response): string | null {
  const companyId = res.locals['companyId'];
  return typeof companyId === 'string' && companyId ? companyId : null;
}

function hasCompanyKnowledgeAuthority(res: Response): boolean {
  return res.locals['isSuperAdmin'] === true || res.locals['adminRole'] === 'COMPANY_ADMIN';
}

function requireCompanyKnowledgeAuthority(res: Response): boolean {
  if (hasCompanyKnowledgeAuthority(res)) return true;
  fail(res, 403, 'Company administrator access is required');
  return false;
}

export function createMemoryRoutes(deps: MemoryRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'canonical-memory-routes' });

  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    if (!requireCompanyKnowledgeAuthority(res)) return;
    const companyId = companyIdFor(res);
    if (!companyId) { fail(res, 401, 'Unauthorized'); return; }
    try {
      const resources = await deps.prisma.knowledgeResource.findMany({
        where: { companyId, kind: 'memory', status: 'active' },
        select: {
          scope: true,
          versions: { orderBy: { version: 'desc' }, take: 1, select: { contentJson: true } },
        },
      });
      const stats = resources.reduce((counts, resource) => {
        const count = readFacts(resource.versions[0]?.contentJson).length;
        if (resource.scope === 'personal') counts.totalPersonal += count;
        if (resource.scope === 'department') counts.totalDepartment += count;
        if (resource.scope === 'company') counts.totalCompany += count;
        return counts;
      }, { totalPersonal: 0, totalDepartment: 0, totalCompany: 0 });
      success(res, stats, 'Memory stats loaded');
    } catch (cause) {
      log.error('memory.stats.failed', { companyId, error: String(cause) });
      fail(res, 500, 'Failed to load memory stats');
    }
  });

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    if (!requireCompanyKnowledgeAuthority(res)) return;
    const companyId = companyIdFor(res);
    if (!companyId) { fail(res, 401, 'Unauthorized'); return; }
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid memory filters');
      return;
    }

    try {
      const resources = await deps.prisma.knowledgeResource.findMany({
        where: {
          companyId,
          kind: 'memory',
          status: 'active',
          scope: parsed.data.scope ?? { in: ['department', 'company'] },
          ...(parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: parsed.data.limit,
        include: {
          ownerUser: { select: { name: true, email: true } },
          department: { select: { name: true } },
          versions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: { version: true, contentJson: true, sourceType: true, createdAt: true },
          },
        },
      });
      const memories = resources.flatMap(resource => {
        const version = resource.versions[0];
        if (!version) return [];
        return readFacts(version.contentJson).map((memory, index) => ({
          id: `${resource.id}:${index}`,
          memory,
          scope: resource.scope,
          createdAt: version.createdAt.toISOString(),
          updatedAt: resource.updatedAt.toISOString(),
          metadata: {
            source: version.sourceType,
            subject: resource.logicalKey,
            version: version.version,
            ...(resource.ownerUser
              ? { owner: resource.ownerUser.name ?? resource.ownerUser.email }
              : {}),
            ...(resource.department ? { department: resource.department.name } : {}),
          },
        }));
      }).slice(0, parsed.data.limit);
      success(res, memories, 'Memories loaded');
    } catch (cause) {
      log.error('memory.list.failed', { companyId, error: String(cause) });
      fail(res, 500, 'Failed to load memories');
    }
  });

  router.get('/operations', async (req: Request, res: Response): Promise<void> => {
    if (!requireCompanyKnowledgeAuthority(res)) return;
    const companyId = companyIdFor(res);
    if (!companyId) { fail(res, 401, 'Unauthorized'); return; }
    const parsed = projectionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid operations filters');
      return;
    }
    try {
      const [health, failed] = await Promise.all([
        deps.operations.health(new Date(), companyId),
        deps.operations.listFailedProjections({ companyId, limit: parsed.data.limit }),
      ]);
      success(res, {
        health,
        failedProjections: failed.map(event => ({
          id: event.id,
          eventType: event.eventType,
          attempts: event.attempts,
          error: event.lastError,
          createdAt: event.createdAt.toISOString(),
          updatedAt: event.updatedAt.toISOString(),
          resource: {
            mutationId: event.mutation.id,
            kind: event.mutation.kind,
            scope: event.mutation.scope,
            subject: event.mutation.logicalKey,
            department: event.mutation.department?.name ?? null,
          },
        })),
      }, 'Knowledge operations loaded');
    } catch (cause) {
      log.error('memory.operations.failed', { companyId, error: String(cause) });
      fail(res, 500, 'Failed to load knowledge operations');
    }
  });

  router.post('/projections/:eventId/retry', async (req: Request, res: Response): Promise<void> => {
    if (!requireCompanyKnowledgeAuthority(res)) return;
    const companyId = companyIdFor(res);
    if (!companyId) { fail(res, 401, 'Unauthorized'); return; }
    const parsed = projectionIdSchema.safeParse(req.params['eventId']);
    if (!parsed.success) { fail(res, 400, 'Invalid projection event ID'); return; }
    try {
      const retried = await deps.operations.retryFailedProjection({
        companyId,
        eventId: parsed.data,
      });
      if (!retried) {
        fail(res, 404, 'Failed projection was not found in this company');
        return;
      }
      const actorId = typeof res.locals['userId'] === 'string' ? res.locals['userId'] : 'unknown';
      deps.audit?.record({
        actorId,
        companyId,
        action: 'knowledge.projection.retry',
        outcome: 'success',
        metadata: { eventId: parsed.data },
      });
      success(res, { eventId: parsed.data, status: 'pending' }, 'Projection retry queued');
    } catch (cause) {
      log.error('memory.projection_retry.failed', {
        companyId,
        eventId: parsed.data,
        error: String(cause),
      });
      fail(res, 500, 'Failed to retry knowledge projection');
    }
  });

  const governedDeleteOnly = (_req: Request, res: Response) => {
    if (!requireCompanyKnowledgeAuthority(res)) return;
    fail(
      res,
      409,
      'Direct admin deletion is disabled. Delete through the governed knowledge review and approval flow.',
    );
  };
  router.delete('/:id', governedDeleteOnly);
  router.delete('/user/:userId', governedDeleteOnly);

  return router;
}

function readFacts(content: unknown): string[] {
  const parsed = z.object({ facts: z.array(z.string()) }).safeParse(content);
  return parsed.success ? parsed.data.facts : [];
}
