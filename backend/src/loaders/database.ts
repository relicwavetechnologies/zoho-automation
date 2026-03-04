import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

export const initDatabase = async (): Promise<void> => {
  await prisma.$connect();
  logger.info('database.connected', { client: 'prisma' }, { always: true });
};

