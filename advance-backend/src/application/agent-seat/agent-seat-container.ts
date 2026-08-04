import type { Container } from '../../composition';
import { buildContainer } from '../../composition';
import type { TypedEnv } from '../../config/env';
import { disconnectAllRedis } from '../../infrastructure/cache/redis.client';
import { disconnectPrisma } from '../../infrastructure/persistence/prisma.client';

export async function buildAgentSeatContainer(env: TypedEnv): Promise<Container> {
  return buildContainer(env, { skipLarkInitialize: true });
}

export async function shutdownAgentSeatContainer(): Promise<void> {
  await Promise.all([disconnectPrisma(), disconnectAllRedis()]);
}
