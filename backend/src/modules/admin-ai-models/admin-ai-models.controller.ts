import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { auditService } from '../audit/audit.service';
import { aiModelControlService, type AiControlTargetKey } from '../../company/ai-models';
import { updateAiModelTargetSchema } from './dto/update-ai-model-target.dto';

class AdminAiModelsController extends BaseController {
  private readSession = (req: Request) =>
    (req as Request & {
      adminSession?: {
        userId: string;
        role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
        companyId?: string;
      };
    }).adminSession;

  listTargets = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const result = await aiModelControlService.listControlPlane();
    return res.json(ApiResponse.success(result, 'AI model controls loaded'));
  };

  updateTarget = async (req: Request, res: Response) => {
    const session = this.readSession(req);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Admin session required' });
    }

    const targetKey = req.params.targetKey as AiControlTargetKey;
    const payload = updateAiModelTargetSchema.parse(req.body);
    const result = await aiModelControlService.updateTarget({
      targetKey,
      provider: payload.provider,
      modelId: payload.modelId,
      thinkingLevel: payload.thinkingLevel ?? undefined,
      fastProvider: payload.fastProvider ?? undefined,
      fastModelId: payload.fastModelId ?? undefined,
      fastThinkingLevel: payload.fastThinkingLevel ?? undefined,
      xtremeProvider: payload.xtremeProvider ?? undefined,
      xtremeModelId: payload.xtremeModelId ?? undefined,
      xtremeThinkingLevel: payload.xtremeThinkingLevel ?? undefined,
      updatedBy: session.userId,
    });

    await auditService.recordLog({
      actorId: session.userId,
      action: 'ai_model_target.update',
      outcome: 'success',
      metadata: {
        targetKey,
        provider: result.effectiveProvider,
        modelId: result.effectiveModelId,
        thinkingLevel: result.effectiveThinkingLevel,
        fastProvider: result.fastEffectiveProvider,
        fastModelId: result.fastEffectiveModelId,
        fastThinkingLevel: result.fastEffectiveThinkingLevel,
        xtremeProvider: result.xtremeEffectiveProvider,
        xtremeModelId: result.xtremeEffectiveModelId,
        xtremeThinkingLevel: result.xtremeEffectiveThinkingLevel,
      },
    });

    return res.json(ApiResponse.success(result, 'AI model target updated'));
  };
}

export const adminAiModelsController = new AdminAiModelsController();
