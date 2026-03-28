import type { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { executionService } from '../../company/observability';
import type { ExecutionActorType, ExecutionChannel, ExecutionPhase, ExecutionRunStatus } from '../../company/contracts';

type AdminSession = {
  userId: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  companyId?: string;
};

class AdminExecutionsController extends BaseController {
  private readSession(req: Request): AdminSession {
    const session = (req as Request & { adminSession?: AdminSession }).adminSession;
    if (!session) throw new HttpException(401, 'Admin session required');
    return session;
  }

  list = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await executionService.listRuns(
      {
        role: 'admin',
        adminRole: session.role,
        companyId: session.companyId,
      },
      this.readFilters(req),
    );
    return res.json(ApiResponse.success(result, 'Execution runs loaded'));
  };

  insights = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await executionService.getInsights(
      {
        role: 'admin',
        adminRole: session.role,
        companyId: session.companyId,
      },
      this.readFilters(req),
    );
    return res.json(ApiResponse.success(result, 'Execution insights loaded'));
  };

  get = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await executionService.getRun(
      {
        role: 'admin',
        adminRole: session.role,
        companyId: session.companyId,
      },
      req.params.executionId,
    );
    return res.json(ApiResponse.success(result, 'Execution run loaded'));
  };

  events = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    const result = await executionService.listRunEvents(
      {
        role: 'admin',
        adminRole: session.role,
        companyId: session.companyId,
      },
      req.params.executionId,
      {
        phase: typeof req.query.phase === 'string' ? (req.query.phase as ExecutionPhase) : undefined,
        actorType: typeof req.query.actorType === 'string' ? (req.query.actorType as ExecutionActorType) : undefined,
      },
    );
    return res.json(ApiResponse.success(result, 'Execution events loaded'));
  };

  private readFilters(req: Request) {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
    return {
      query: typeof req.query.query === 'string' ? req.query.query : undefined,
      userId: typeof req.query.userId === 'string' ? req.query.userId : undefined,
      companyId: typeof req.query.companyId === 'string' ? req.query.companyId : undefined,
      channel: typeof req.query.channel === 'string' ? (req.query.channel as ExecutionChannel) : undefined,
      mode: typeof req.query.mode === 'string' ? (req.query.mode as 'fast' | 'high') : undefined,
      status: typeof req.query.status === 'string' ? (req.query.status as ExecutionRunStatus) : undefined,
      dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
      phase: typeof req.query.phase === 'string' ? (req.query.phase as ExecutionPhase) : undefined,
      actorType: typeof req.query.actorType === 'string' ? (req.query.actorType as ExecutionActorType) : undefined,
      page,
      pageSize,
    };
  }
}

export const adminExecutionsController = new AdminExecutionsController();
