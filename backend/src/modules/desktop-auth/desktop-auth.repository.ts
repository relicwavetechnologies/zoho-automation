import type { DesktopAuthHandoff } from '../../generated/prisma';
import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class DesktopAuthRepository extends BaseRepository {
  createHandoff(data: {
    code: string;
    userId: string;
    companyId: string;
    role: string;
    expiresAt: Date;
  }): Promise<DesktopAuthHandoff> {
    return prisma.desktopAuthHandoff.create({ data });
  }

  findHandoffByCode(code: string): Promise<DesktopAuthHandoff | null> {
    return prisma.desktopAuthHandoff.findUnique({ where: { code } });
  }

  consumeHandoff(id: string): Promise<DesktopAuthHandoff> {
    return prisma.desktopAuthHandoff.update({
      where: { id },
      data: { consumedAt: new Date() },
    });
  }
}

export const desktopAuthRepository = new DesktopAuthRepository();
