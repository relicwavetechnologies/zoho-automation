import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { vercelDesktopEngine } from './vercel-desktop.engine';

const shareConversationSchema = z.object({
  reason: z.string().max(1000).optional(),
});

type MemberRequest = Request & { memberSession?: MemberSessionDTO };

class DesktopChatController extends BaseController {
  private session(req: Request): MemberSessionDTO {
    const session = (req as MemberRequest).memberSession;
    if (!session) {
      throw new HttpException(401, 'Member session required');
    }
    return session;
  }

  send = async (req: Request, res: Response): Promise<void> =>
    vercelDesktopEngine.stream(req, res, this.session(req));

  actStream = async (req: Request, res: Response): Promise<void> =>
    vercelDesktopEngine.streamAct(req, res, this.session(req));

  act = async (req: Request, res: Response): Promise<Response> =>
    vercelDesktopEngine.act(req, res, this.session(req));

  shareConversation = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const requesterAiRole = session.aiRole ?? session.role;
    const threadId = req.params.threadId;
    const { reason } = shareConversationSchema.parse(req.body ?? {});

    const allowed = await toolPermissionService.isAllowed(
      session.companyId,
      'share_chat_vectors',
      requesterAiRole,
    );
    if (!allowed) {
      throw new HttpException(403, 'Your role cannot share knowledge from desktop chats');
    }

    const result = await knowledgeShareService.requestConversationShare({
      companyId: session.companyId,
      requesterUserId: session.userId,
      requesterAiRole,
      conversationKey: `desktop:${threadId}`,
      humanReason: reason,
    });

    return res.json(ApiResponse.success(result, 'Conversation share processed'));
  };
}

export const desktopChatController = new DesktopChatController();
