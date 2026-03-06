import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { auditService } from '../audit/audit.service';
import { AdminRuntimeService, adminRuntimeService } from './admin-runtime.service';
import { controlTaskSchema } from './dto/control-task.dto';

class AdminRuntimeController extends BaseController {
  constructor(private readonly service: AdminRuntimeService = adminRuntimeService) {
    super();
  }

  private readSession(req: Request): { userId: string; role: 'SUPER_ADMIN' | 'COMPANY_ADMIN'; companyId?: string } {
    const session = (req as Request & {
      adminSession?: { userId: string; role: 'SUPER_ADMIN' | 'COMPANY_ADMIN'; companyId?: string };
    }).adminSession;
    if (!session) {
      throw new HttpException(401, 'Admin session required');
    }
    return session;
  }

  getHealth = async (req: Request, res: Response) => {
    const result = await this.service.getHealth(this.readSession(req));
    return res.json(ApiResponse.success(result, 'Runtime health loaded'));
  };

  listTasks = async (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;
    const result = await this.service.listTasks(this.readSession(req), Number.isFinite(limit) ? limit : 30);
    return res.json(ApiResponse.success(result, 'Runtime tasks loaded'));
  };

  getTask = async (req: Request, res: Response) => {
    const result = await this.service.getTask(this.readSession(req), req.params.taskId);
    return res.json(ApiResponse.success(result, 'Runtime task loaded'));
  };

  getTaskTrace = async (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const result = await this.service.getTaskTrace(this.readSession(req), req.params.taskId, Number.isFinite(limit) ? limit : 100);
    return res.json(ApiResponse.success(result, 'Runtime task trace loaded'));
  };

  controlTask = async (req: Request, res: Response) => {
    const payload = controlTaskSchema.parse(req.body);
    const taskId = req.params.taskId;
    const session = (req as Request & { adminSession?: { userId: string; companyId?: string; role: 'SUPER_ADMIN' | 'COMPANY_ADMIN' } }).adminSession;
    const actorId = session?.userId ?? 'unknown';

    try {
      const result = await this.service.controlTask(this.readSession(req), taskId, payload);
      await auditService.recordLog({
        actorId,
        companyId: session?.companyId,
        action: `runtime.task.control.${payload.action}`,
        outcome: 'success',
        metadata: { taskId },
      });
      return res.json(ApiResponse.success(result, 'Runtime task control applied'));
    } catch (error) {
      await auditService.recordLog({
        actorId,
        companyId: session?.companyId,
        action: `runtime.task.control.${payload.action}`,
        outcome: 'failure',
        metadata: {
          taskId,
          error: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  };

  recoverTask = async (req: Request, res: Response) => {
    const taskId = req.params.taskId;
    const session = (req as Request & { adminSession?: { userId: string; companyId?: string; role: 'SUPER_ADMIN' | 'COMPANY_ADMIN' } }).adminSession;
    const actorId = session?.userId ?? 'unknown';

    try {
      const result = await this.service.recoverTask(this.readSession(req), taskId);
      await auditService.recordLog({
        actorId,
        companyId: session?.companyId,
        action: 'runtime.task.recover',
        outcome: 'success',
        metadata: {
          taskId,
          recoveredFromVersion: result.recoveredFromVersion,
          recoveredFromNode: result.recoveredFromNode,
          recoveryMode: result.recoveryMode,
          resumeDecisionReason: result.resumeDecisionReason,
        },
      });
      return res.status(202).json(ApiResponse.success(result, 'Runtime task recovery queued'));
    } catch (error) {
      await auditService.recordLog({
        actorId,
        companyId: session?.companyId,
        action: 'runtime.task.recover',
        outcome: 'failure',
        metadata: {
          taskId,
          error: error instanceof Error ? error.message : 'unknown_error',
        },
      });
      throw error;
    }
  };
}

export const adminRuntimeController = new AdminRuntimeController();
