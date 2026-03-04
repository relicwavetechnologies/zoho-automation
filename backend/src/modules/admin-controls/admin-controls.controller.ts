import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { auditService } from '../audit/audit.service';
import { AdminControlsService, adminControlsService } from './admin-controls.service';
import { applyControlSchema } from './dto/apply-control.dto';

class AdminControlsController extends BaseController {
  constructor(private readonly service: AdminControlsService = adminControlsService) {
    super();
  }

  listControls = async (req: Request, res: Response) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const result = await this.service.listControls(companyId);
    return res.json(ApiResponse.success(result, 'Admin controls loaded'));
  };

  applyControl = async (req: Request, res: Response) => {
    const payload = applyControlSchema.parse(req.body);
    const session = (req as Request & { adminSession?: { userId: string; companyId?: string } }).adminSession;
    const actorId = session?.userId ?? 'unknown';

    try {
      const result = await this.service.applyControl(payload, actorId);
      await auditService.recordLog({
        actorId,
        companyId: payload.companyId,
        action: `admin.control.apply.${payload.controlKey}`,
        outcome: 'success',
        metadata: {
          requestedValue: payload.requestedValue,
        },
      });
      return res.json(ApiResponse.success(result, 'Control applied'));
    } catch (error) {
      await auditService.recordLog({
        actorId,
        companyId: payload.companyId,
        action: `admin.control.apply.${payload.controlKey}`,
        outcome: 'failure',
        metadata: {
          requestedValue: payload.requestedValue,
          error: error instanceof Error ? error.message : 'Unknown failure',
        },
      });
      throw error;
    }
  };
}

export const adminControlsController = new AdminControlsController();
