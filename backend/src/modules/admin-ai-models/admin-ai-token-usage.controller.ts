import { Request, Response } from 'express';
import { z } from 'zod';
import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import { HttpException } from '../../core/http-exception';
import { aiTokenUsageService } from '../../company/ai-usage/ai-token-usage.service';

const querySchema = z.object({
  months: z.coerce.number().min(1).max(12).optional().default(1),
});

class AdminAiTokenUsageController extends BaseController {
  private session(req: Request) {
    const s = (req as unknown as { adminSession?: any }).adminSession;
    if (!s) throw new HttpException(401, 'Admin session required');
    return s;
  }

  getCompanyTokenUsage = async (req: Request, res: Response) => {
    this.session(req); // ensure logged in
    const companyId = req.params.companyId;
    if (!companyId) throw new HttpException(400, 'Company ID is required');

    const { months } = querySchema.parse(req.query);
    const breakdown = await aiTokenUsageService.getCompanyBreakdown(companyId, months);
    res.json(ApiResponse.success(breakdown));
  };
}

export const adminAiTokenUsageController = new AdminAiTokenUsageController();
