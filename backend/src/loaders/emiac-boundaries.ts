import { EMIAC_BOUNDARY_MODULES } from '../emiac';
import { logger } from '../utils/logger';

export const initEmiacBoundaries = (): void => {
  const moduleKeys = EMIAC_BOUNDARY_MODULES.map((module) => module.key).join(', ');
  logger.info(`EMIAC boundary scaffold initialized: ${moduleKeys}`);
};

