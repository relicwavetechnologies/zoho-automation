import { COMPANY_BOUNDARY_MODULES } from '../company';
import { logger } from '../utils/logger';

export const initCompanyBoundaries = (): void => {
  const moduleKeys = COMPANY_BOUNDARY_MODULES.map((module) => module.key).join(', ');
  logger.info('orchestration.boundaries.initialized', { modules: moduleKeys }, { always: true });
};
