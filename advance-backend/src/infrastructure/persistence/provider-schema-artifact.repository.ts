import type { PrismaClient } from '../../generated/prisma';
import type {
  ProviderSchemaArtifact,
  ProviderSchemaArtifactStore,
} from '../../application/gateway/provider-schema-artifact-catalogue';
import { wrapInfra } from '../../shared/errors';
import { err, ok } from '../../shared/result';

/** Postgres is the durable owner; process maps and future Redis reads are accelerators only. */
export class ProviderSchemaArtifactRepository implements ProviderSchemaArtifactStore {
  constructor(private readonly db: PrismaClient) {}

  async readHead(input: {
    readonly provider: ProviderSchemaArtifact['provider'];
    readonly partitionKey: string;
    readonly projectionRevision: string;
  }) {
    try {
      const head = await this.db.providerSchemaArtifactHead.findUnique({
        where: {
          provider_partitionKey_projectionRevision: {
            provider: input.provider,
            partitionKey: input.partitionKey,
            projectionRevision: input.projectionRevision,
          },
        },
        include: { artifact: true },
      });
      if (!head) return ok(null);
      return ok({
        provider: input.provider,
        partitionKey: head.artifact.partitionKey,
        projectionRevision: head.artifact.projectionRevision,
        digest: head.artifact.digest,
        payload: head.artifact.payload,
        byteLength: head.artifact.byteLength,
        schemaCount: head.artifact.schemaCount,
        checkedAt: head.checkedAt,
        expiresAt: head.expiresAt,
      });
    } catch (error) {
      return err(wrapInfra('prisma', 'provider_schema_artifact.read_head', error));
    }
  }

  async publish(artifact: ProviderSchemaArtifact) {
    try {
      await this.db.$transaction(async tx => {
        const stored = await tx.providerSchemaArtifact.upsert({
          where: {
            provider_partitionKey_projectionRevision_digest: {
              provider: artifact.provider,
              partitionKey: artifact.partitionKey,
              projectionRevision: artifact.projectionRevision,
              digest: artifact.digest,
            },
          },
          create: {
            provider: artifact.provider,
            partitionKey: artifact.partitionKey,
            projectionRevision: artifact.projectionRevision,
            digest: artifact.digest,
            payload: artifact.payload,
            byteLength: artifact.byteLength,
            schemaCount: artifact.schemaCount,
          },
          update: {},
          select: { id: true },
        });
        const current = await tx.providerSchemaArtifactHead.findUnique({
          where: {
            provider_partitionKey_projectionRevision: {
              provider: artifact.provider,
              partitionKey: artifact.partitionKey,
              projectionRevision: artifact.projectionRevision,
            },
          },
          select: { checkedAt: true },
        });
        if (current && current.checkedAt.getTime() > artifact.checkedAt.getTime()) return;
        await tx.providerSchemaArtifactHead.upsert({
          where: {
            provider_partitionKey_projectionRevision: {
              provider: artifact.provider,
              partitionKey: artifact.partitionKey,
              projectionRevision: artifact.projectionRevision,
            },
          },
          create: {
            provider: artifact.provider,
            partitionKey: artifact.partitionKey,
            projectionRevision: artifact.projectionRevision,
            artifactId: stored.id,
            checkedAt: artifact.checkedAt,
            expiresAt: artifact.expiresAt,
          },
          update: {
            artifactId: stored.id,
            checkedAt: artifact.checkedAt,
            expiresAt: artifact.expiresAt,
          },
        });
      }, { isolationLevel: 'Serializable' });
      return ok(undefined);
    } catch (error) {
      return err(wrapInfra('prisma', 'provider_schema_artifact.publish', error));
    }
  }
}
