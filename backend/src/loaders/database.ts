import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

export const initDatabase = async (): Promise<void> => {
  await prisma.$connect();
  logger.info('Database connected via Prisma');
};


