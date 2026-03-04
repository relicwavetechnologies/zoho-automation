import { BaseService } from '../../core/service';

import { AuditRepository, auditRepository } from './audit.repository';
import { QueryAuditDto } from './dto/query-audit.dto';

export class AuditService extends BaseService {
  constructor(private readonly repository: AuditRepository = auditRepository) {
    super();
  }

  async recordLog(input: {
    actorId: string;
    companyId?: string;
    action: string;
    outcome: 'success' | 'failure';
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.repository.createLog(input);
  }

  async queryLogs(input: QueryAuditDto) {
    const rows = await this.repository.queryLogs(input);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actorId,
      companyId: row.companyId,
      action: row.action,
      outcome: row.outcome,
      timestamp: row.createdAt.toISOString(),
      metadata: row.metadata,
    }));
  }
}

export const auditService = new AuditService();
