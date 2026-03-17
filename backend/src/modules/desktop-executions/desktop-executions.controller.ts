import type { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { executionService } from '../../company/observability';
import type { ExecutionActorType, ExecutionPhase } from '../../company/contracts';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

const appendExecutionEventSchema = z.object({
  phase: z.enum(['request', 'planning', 'tool', 'synthesis', 'delivery', 'error', 'control']),
  eventType: z.string().min(1).max(200),
  actorType: z.enum(['system', 'planner', 'agent', 'tool', 'model', 'delivery']),
  actorKey: z.string().min(1).max(200).optional().nullable(),
  title: z.string().min(1).max(200),
  summary: z.string().max(6000).optional().nullable(),
  status: z.string().min(1).max(50).optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
});

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

  appendEvent = async (req: Request, res: Response) => {
    const session = this.session(req);
    const executionId = req.params.executionId;
    await executionService.getRun(
      {
        role: 'member',
        userId: session.userId,
        companyId: session.companyId,
      },
      executionId,
    );

    const input = appendExecutionEventSchema.parse(req.body ?? {});
    const item = await executionService.appendEvent({
      executionId,
      phase: input.phase,
      eventType: input.eventType,
      actorType: input.actorType,
      actorKey: input.actorKey ?? undefined,
      title: input.title,
      summary: input.summary ?? undefined,
      status: input.status ?? undefined,
      payload: input.payload ?? undefined,
    });

    return res.json(ApiResponse.success(item, 'Execution event stored'));
  };
}

export const desktopExecutionsController = new DesktopExecutionsController();
