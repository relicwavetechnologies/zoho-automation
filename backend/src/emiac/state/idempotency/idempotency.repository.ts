import { Prisma } from '../../../generated/prisma';
import { prisma } from '../../../utils/prisma';

export class IdempotencyRepository {
  async claimIngressMessageId(channel: string, messageId: string): Promise<boolean> {
    try {
      await prisma.ingressIdempotencyKey.create({
        data: {
          channel,
          messageId,
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }

      throw error;
    }
  }
}

export const idempotencyRepository = new IdempotencyRepository();
