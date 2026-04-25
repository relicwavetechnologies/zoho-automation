import { PrismaClient } from '../../generated/prisma';

let _prisma: PrismaClient | null = null;

export const getPrismaClient = (): PrismaClient => {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: process.env['NODE_ENV'] === 'development'
        ? ['warn', 'error']
        : ['error'],
    });
  }
  return _prisma;
};

export const disconnectPrisma = async (): Promise<void> => {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
};
