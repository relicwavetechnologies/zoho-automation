import { Request, Response } from 'express';

import { ApiResponse } from '../../core/api-response';
import { BaseController } from '../../core/controller';
import {
  CompanyOnboardingService,
  companyOnboardingService,
} from './company-onboarding.service';
import { deltaSyncEventSchema } from './dto/delta-sync-event.dto';
import { lifecycleParamsSchema } from './dto/lifecycle-params.dto';
import { zohoConnectSchema } from './dto/zoho-connect.dto';

class CompanyOnboardingController extends BaseController {
  constructor(
    private readonly service: CompanyOnboardingService = companyOnboardingService,
  ) {
    super();
  }

  connectZoho = async (req: Request, res: Response) => {
    const payload = zohoConnectSchema.parse(req.body);
    const result = await this.service.connectZoho(payload);

    return res.status(202).json(ApiResponse.success(result, 'Zoho connected and initial sync queued'));
  };

  getHistoricalSyncStatus = async (req: Request, res: Response) => {
    const jobId = req.params.jobId;
    const result = await this.service.getHistoricalSyncStatus(jobId);
    return res.json(ApiResponse.success(result, 'Historical sync status loaded'));
  };

  processDeltaSyncEvent = async (req: Request, res: Response) => {
    const event = deltaSyncEventSchema.parse(req.body);
    const result = await this.service.handleDeltaSyncEvent(event);
    return res.status(202).json(ApiResponse.success(result, 'Delta sync event accepted'));
  };

  validateLifecycle = async (req: Request, res: Response) => {
    const params = lifecycleParamsSchema.parse(req.params);
    const result = await this.service.validateOnboardingLifecycle(params.companyId);
    return res.json(ApiResponse.success(result, 'Onboarding lifecycle validation completed'));
  };

  getCompanyOnboardingStatus = async (req: Request, res: Response) => {
    const params = lifecycleParamsSchema.parse(req.params);
    const result = await this.service.getCompanyOnboardingStatus(params.companyId);
    return res.json(ApiResponse.success(result, 'Company onboarding status loaded'));
  };
}

export const companyOnboardingController = new CompanyOnboardingController();
