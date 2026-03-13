import type { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { executionService } from '../../company/observability';
import type { ExecutionActorType, ExecutionPhase } from '../../company/contracts';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopExecutionsController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const session = (req as MemberRequest).memberSession;
    if (!session) throw new HttpException(401, 'Member session required');
    return session;
  }

  get = async (req: Request, res: Response) => {
    const session = this.session(req);
    const result = await executionService.getRun(
      {
        role: 'member',
        userId: session.userId,
        companyId: session.companyId,
      },
      req.params.executionId,
    );
    return res.json(ApiResponse.success(result, 'Execution run loaded'));
  };

  events = async (req: Request, res: Response) => {
    const session = this.session(req);
    const result = await executionService.listRunEvents(
      {
        role: 'member',
        userId: session.userId,
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
}

export const desktopExecutionsController = new DesktopExecutionsController();
