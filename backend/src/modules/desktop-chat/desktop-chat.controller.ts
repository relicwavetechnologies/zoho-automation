import { Request, Response } from 'express';
import { z } from 'zod';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { toolPermissionService } from '../../company/tools/tool-permission.service';
import { knowledgeShareService } from '../../company/knowledge-share/knowledge-share.service';
import { hitlActionService, executeStoredRemoteToolAction } from '../../company/state';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { langgraphDesktopEngine } from './langgraph-desktop.engine';

const shareConversationSchema = z.object({
  reason: z.string().max(1000).optional(),
});

const hitlDecisionSchema = z.object({
  decision: z.enum(['confirmed', 'cancelled']),
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
    langgraphDesktopEngine.stream(req, res, this.session(req));

  actStream = async (req: Request, res: Response): Promise<void> =>
    langgraphDesktopEngine.streamAct(req, res, this.session(req));

  act = async (req: Request, res: Response): Promise<Response> =>
    langgraphDesktopEngine.act(req, res, this.session(req));

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

  resolveHitlAction = async (req: Request, res: Response): Promise<Response> => {
    const session = this.session(req);
    const threadId = req.params.threadId;
    const actionId = req.params.actionId;
    const { decision } = hitlDecisionSchema.parse(req.body ?? {});

    const action = await hitlActionService.getStoredAction(actionId);
    if (!action) {
      throw new HttpException(404, 'Approval action not found');
    }
    if (action._threadId && action._threadId !== threadId) {
      throw new HttpException(403, 'Approval action does not belong to this thread');
    }
    if (action.status !== 'pending') {
      throw new HttpException(409, `Approval action is already ${action.status}`);
    }
    if (action.metadata?.companyId && action.metadata.companyId !== session.companyId) {
      throw new HttpException(403, 'Approval action does not belong to this company');
    }

    const resolved = await hitlActionService.resolveByActionId(actionId, decision);
    if (!resolved) {
      throw new HttpException(409, 'Approval action is no longer pending');
    }

    if (decision === 'cancelled') {
      return res.json(ApiResponse.success({
        kind: 'tool_action',
        ok: false,
        summary: `User rejected ${action.summary}`,
      }, 'Approval action rejected'));
    }

    try {
      const result = await executeStoredRemoteToolAction(action);
      return res.json(ApiResponse.success({
        kind: 'tool_action',
        ok: result.ok,
        summary: result.summary,
        payload: result.payload,
      }, 'Approval action executed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval action execution failed';
      return res.json(ApiResponse.success({
        kind: 'tool_action',
        ok: false,
        summary: message,
      }, 'Approval action execution failed'));
    }
  };
}

export const desktopChatController = new DesktopChatController();
