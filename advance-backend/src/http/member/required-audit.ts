import type { Response } from 'express';
import type {
  AuditService,
  BeginAuditInput,
  SettleAuditInput,
} from '../../application/observability/audit.service';
import type { Logger } from '../../shared/logger';

/** Member-route adapter for audit admission and its retryable failure response. */
export function createRequiredAudit(auditService: AuditService, logger: Logger) {
  return {
    async begin(res: Response, input: BeginAuditInput): Promise<string | null> {
      try {
        return await auditService.beginRequired(input);
      } catch (error) {
        logger.error('audit.required_unavailable', {
          action: input.action,
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({
          ok: false,
          error: 'audit_unavailable',
          message: 'Divo could not record this change, so nothing was changed.',
        });
        return null;
      }
    },

    settle(checkpointId: string, input: Omit<SettleAuditInput, 'checkpointId'>): void {
      auditService.settle({ checkpointId, ...input });
    },
  };
}
