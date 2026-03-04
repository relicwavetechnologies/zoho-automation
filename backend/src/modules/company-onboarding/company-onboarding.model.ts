import type { ZohoConnectionDTO } from '../../emiac/contracts';
import type { IngestionJobDTO } from '../../emiac/contracts';

export type CompanyOnboardingConnectResult = {
  companyId: string;
  environment: string;
  connection: ZohoConnectionDTO;
  initialSync: {
    status: 'queued' | 'already_queued';
    jobId: string;
  };
};

export type HistoricalSyncStatusResult = {
  job: IngestionJobDTO;
  events: Array<{
    id: string;
    fromStatus?: string;
    toStatus: string;
    message?: string;
    createdAt: string;
  }>;
};

export type DeltaSyncEnqueueResult = {
  eventKey: string;
  status: 'queued' | 'already_processed';
  jobId?: string;
};

export type OnboardingLifecycleValidationResult = {
  companyId: string;
  hasConnection: boolean;
  latestHistoricalStatus?: string;
  latestDeltaStatus?: string;
  vectorDocumentCount: number;
  deltaPendingCount: number;
  checks: {
    onboardingConnected: boolean;
    historicalCompleted: boolean;
    deltaPipelineHealthy: boolean;
    vectorsAvailable: boolean;
  };
};
