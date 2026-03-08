import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { MemberSessionDTO } from '../member-auth/member-auth.service';
import { desktopThreadsService } from './desktop-threads.service';

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopThreadsController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const s = (req as MemberRequest).memberSession;
    if (!s) throw new Error('Member session required');
    return s;
  }

  list = async (req: Request, res: Response) => {
    const s = this.session(req);
    const threads = await desktopThreadsService.listThreads(s.userId, s.companyId);
    return res.json(ApiResponse.success(threads, 'Threads listed'));
  };

  get = async (req: Request, res: Response) => {
    const s = this.session(req);
    const result = await desktopThreadsService.getThread(req.params.threadId, s.userId);
    return res.json(ApiResponse.success(result, 'Thread loaded'));
  };

  create = async (req: Request, res: Response) => {
    const s = this.session(req);
    const thread = await desktopThreadsService.createThread(s.userId, s.companyId);
    return res.status(201).json(ApiResponse.success(thread, 'Thread created'));
  };

  delete = async (req: Request, res: Response) => {
    const s = this.session(req);
    await desktopThreadsService.deleteThread(req.params.threadId, s.userId);
    return res.status(204).send();
  };
}

export const desktopThreadsController = new DesktopThreadsController();
