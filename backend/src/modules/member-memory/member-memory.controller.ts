import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { memoryService } from '../../company/memory';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class MemberMemoryController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      throw new Error('Member session required');
    }
    return session;
  }

  list = async (req: Request, res: Response) => {
    const session = this.session(req);
    const result = await memoryService.listForUser({
      companyId: session.companyId,
      userId: session.userId,
    });
    return res.json(ApiResponse.success(result, 'Memory listed'));
  };

  forget = async (req: Request, res: Response) => {
    const session = this.session(req);
    const forgotten = await memoryService.forgetMemory({
      companyId: session.companyId,
      userId: session.userId,
      memoryId: req.params.memoryId,
    });
    return res.json(ApiResponse.success({ forgotten }, forgotten ? 'Memory forgotten' : 'Memory not found'));
  };

  clear = async (req: Request, res: Response) => {
    const session = this.session(req);
    await memoryService.clearUserMemory({
      companyId: session.companyId,
      userId: session.userId,
    });
    return res.json(ApiResponse.success({ cleared: true }, 'Memory cleared'));
  };
}

export const memberMemoryController = new MemberMemoryController();
