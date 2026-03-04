import { EMIAC_BOUNDARY_MODULES } from '../company';
import { logger } from '../utils/logger';

export const initEmiacBoundaries = (): void => {
  const moduleKeys = EMIAC_BOUNDARY_MODULES.map((module) => module.key).join(', ');
  logger.info(`Orchestration boundary scaffold initialized: ${moduleKeys}`);
};
