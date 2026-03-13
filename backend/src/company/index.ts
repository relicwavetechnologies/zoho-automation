import { AGENTS_BOUNDARY } from './agents';
import { CHANNELS_BOUNDARY } from './channels';
import { CONTRACTS_BOUNDARY } from './contracts';
import { INTEGRATIONS_BOUNDARY } from './integrations';
import { OBSERVABILITY_BOUNDARY } from './observability';
import { ORCHESTRATION_BOUNDARY } from './orchestration';
import { QUEUE_BOUNDARY } from './queue';
import { SECURITY_BOUNDARY } from './security';
import { STATE_BOUNDARY } from './state';

export const COMPANY_BOUNDARY_MODULES = [
  CONTRACTS_BOUNDARY,
  CHANNELS_BOUNDARY,
  INTEGRATIONS_BOUNDARY,
  AGENTS_BOUNDARY,
  ORCHESTRATION_BOUNDARY,
  QUEUE_BOUNDARY,
  STATE_BOUNDARY,
  SECURITY_BOUNDARY,
  OBSERVABILITY_BOUNDARY,
] as const;

export type CompanyBoundaryModule = (typeof COMPANY_BOUNDARY_MODULES)[number];

export * from './agents';
export * from './channels';
export * from './contracts';
export * from './integrations';
export * from './observability';
export * from './orchestration';
export * from './queue';
export * from './security';
export * from './state';
