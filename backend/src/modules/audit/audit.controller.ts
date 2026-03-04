import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { queryAuditSchema } from './dto/query-audit.dto';
import { AuditService, auditService } from './audit.service';

class AuditController extends BaseController {
  constructor(private readonly service: AuditService = auditService) {
    super();
  }

  queryLogs = async (req: Request, res: Response) => {
    const query = queryAuditSchema.parse(req.query);
    const result = await this.service.queryLogs(query);
    return res.json(ApiResponse.success(result, 'Audit logs loaded'));
  };
}

export const auditController = new AuditController();
