/**
 * AuditService — compliance audit logging for privileged actions.
 *
 * Records who did what, when, and whether it succeeded. Called from:
 *   - Admin permission mutation routes (set/delete company or dept permissions)
 *   - Any future admin action (agent config changes, user overrides, etc.)
 *
 * Administrative writes may be fire-and-forget. Sensitive data-access paths
 * use recordRequired() and fail closed when the audit row cannot be persisted.
 * All reads are company-scoped.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecordAuditInput {
  actorId:    string;
  companyId?: string;
  action:     string;            // e.g. 'permission.set_company', 'permission.delete_dept'
  outcome:    'success' | 'failure';
  metadata?:  Record<string, unknown>;
}

export type BeginAuditInput = Omit<RecordAuditInput, 'outcome'> & {
  /** Reuse one still-pending checkpoint across an idempotent retry. */
  checkpointKey?: string;
};

export interface SettleAuditInput {
  checkpointId: string;
  outcome: RecordAuditInput['outcome'];
  /** Full final metadata. Omit it to keep what admission recorded. */
  metadata?: Record<string, unknown>;
}

export interface AuditLogView {
  id:        string;
  actorId:   string;
  companyId: string | null;
  action:    string;
  outcome:   string;
  metadata:  unknown;
  createdAt: string;
}

export interface QueryAuditInput {
  companyId: string;
  actorId?:  string;
  action?:   string;
  limit?:    number;
  offset?:   number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AuditService {
  constructor(
    private readonly prisma:  PrismaClient,
    private readonly logger:  Logger,
  ) {}

  /** Record an administrative action. Non-fatal — logs and swallows DB errors. */
  record(input: RecordAuditInput): void {
    this.write(input).catch(e => {
      this.logger.warn('audit.record.failed', {
        action: input.action,
        error:  String(e),
      });
    });
  }

  /** Persist a compliance-critical audit row or reject the caller. */
  async recordRequired(input: RecordAuditInput): Promise<void> {
    try {
      await this.write(input);
    } catch (error) {
      this.logger.error('audit.record_required.failed', {
        action: input.action,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Persist an audit checkpoint before work that cannot safely be retried.
   *
   * `pending` is deliberate and truthful. If outcome settlement later fails,
   * the durable row still proves who started what and gives operators a record
   * to reconcile instead of losing the action entirely.
   */
  async beginRequired(input: BeginAuditInput): Promise<string> {
    try {
      const checkpointKey = input.checkpointKey;
      const metadata = {
        ...(input.metadata ?? {}),
        ...(checkpointKey ? { checkpointKey } : {}),
      };
      const create = async (store: Pick<Prisma.TransactionClient, 'auditLog'>) => store.auditLog.create({
        data: {
          actorId: input.actorId,
          action: input.action,
          outcome: 'pending',
          ...(input.companyId ? { companyId: input.companyId } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata: sanitizeMeta(metadata) as object } : {}),
        },
        select: { id: true },
      });

      if (!checkpointKey) return (await create(this.prisma)).id;

      const lockKey = JSON.stringify([input.companyId ?? '', input.action, checkpointKey]);
      return await this.prisma.$transaction(async tx => {
        // The exact row still decides reuse; a hash collision can only make an
        // unrelated checkpoint wait. The transaction lock closes the
        // find-then-create race across backend processes without a schema change.
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext('audit-checkpoint'),
            hashtext(${lockKey})
          )::text AS lock_result
        `;
        const existing = await tx.auditLog.findFirst({
          where: {
            companyId: input.companyId ?? null,
            action: input.action,
            outcome: 'pending',
            metadata: { path: ['checkpointKey'], equals: checkpointKey },
          },
          select: { id: true },
        });
        if (existing) return existing.id;
        return (await create(tx)).id;
      });
    } catch (error) {
      this.logger.error('audit.checkpoint.failed', {
        action: input.action,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Settle a checkpoint without turning an already-applied effect into a false
   * HTTP failure. A failed update leaves the durable row visibly `pending`.
   */
  settle(input: SettleAuditInput): void {
    const metadata = input.metadata ? sanitizeMeta(input.metadata) : undefined;
    this.prisma.auditLog.update({
      where: { id: input.checkpointId },
      data: {
        outcome: input.outcome,
        ...(metadata ? { metadata: metadata as object } : {}),
      },
    }).catch(error => {
      this.logger.warn('audit.checkpoint_settle.failed', {
        checkpointId: input.checkpointId,
        outcome: input.outcome,
        error: String(error),
      });
    });
  }

  /** Query audit logs for a company, newest first. */
  async query(input: QueryAuditInput): Promise<AuditLogView[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        companyId: input.companyId,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.action  ? { action:  { contains: input.action } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take:    Math.min(input.limit ?? 100, 500),
      skip:    input.offset ?? 0,
    });

    return logs.map(l => ({
      id:        l.id,
      actorId:   l.actorId,
      companyId: l.companyId,
      action:    l.action,
      outcome:   l.outcome,
      metadata:  l.metadata,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  private async write(input: RecordAuditInput): Promise<void> {
    const safeMetadata = input.metadata ? sanitizeMeta(input.metadata) : undefined;
    await this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        outcome: input.outcome,
        ...(input.companyId ? { companyId: input.companyId } : {}),
        ...(safeMetadata ? { metadata: safeMetadata as object } : {}),
      },
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AUDIT_REDACT_KEYS = new Set([
  'password', 'token', 'secret', 'apikey', 'api_key', 'authorization',
  'cookie', 'set-cookie', 'session', 'accesstoken', 'refreshtoken',
]);

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(meta) as Record<string, unknown>;
}

/** Keep audit metadata safe even when a caller accidentally nests transport data. */
function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = AUDIT_REDACT_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeValue(nested);
  }
  return out;
}
