import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { Artifact, ArtifactSummary, ArtifactWrite } from '../../domain/artifact/artifact';
import { isArtifactMime } from '../../domain/artifact/artifact';

/**
 * Where artifacts live once the container that wrote them is gone.
 *
 * Every method is scoped by company *and* member, and the scope is a parameter
 * rather than a filter the caller may forget: there is no method here that can
 * read an artifact without being told whose it is.
 *
 * `save` is an upsert on the runtime's own artifact key, not an insert. A model
 * that revises a document calls the badge tool again with the same file path, so
 * the second call must land on the first row. Inserting instead would leave a
 * reader choosing between five versions of one report, which is exactly the
 * problem a document has that a chat message does not.
 */

export interface ArtifactScope {
  readonly companyId: string;
  readonly userId: string;
}

export interface ArtifactRepoPort {
  save(scope: ArtifactScope, write: ArtifactWrite): Promise<Result<ArtifactSummary, InfraError>>;
  get(scope: ArtifactScope & { artifactId: string }): Promise<Result<Artifact | null, InfraError>>;
  /** Newest first. `threadId` narrows to one conversation's output. */
  list(
    scope: ArtifactScope & { threadId?: string },
    limit?: number,
  ): Promise<Result<ArtifactSummary[], InfraError>>;
}

type Row = {
  artifactId: string;
  title: string;
  mime: string;
  version: number;
  threadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A row whose mime is no longer one this build renders is not an artifact this
 * build can show. Reported as markdown rather than dropped: the body is still
 * text, and refusing to draw a document because its label aged out helps nobody.
 */
function summaryOf(row: Row): ArtifactSummary {
  return {
    artifactId: row.artifactId,
    title: row.title,
    mime: isArtifactMime(row.mime) ? row.mime : 'text/markdown',
    version: row.version,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SUMMARY_SELECT = {
  artifactId: true,
  title: true,
  mime: true,
  version: true,
  threadId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class ArtifactRepository implements ArtifactRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async save(
    scope: ArtifactScope,
    write: ArtifactWrite,
  ): Promise<Result<ArtifactSummary, InfraError>> {
    try {
      const row = await this.db.artifact.upsert({
        where: {
          companyId_userId_artifactId: {
            companyId: scope.companyId,
            userId: scope.userId,
            artifactId: write.artifactId,
          },
        },
        create: {
          companyId: scope.companyId,
          userId: scope.userId,
          artifactId: write.artifactId,
          title: write.title,
          mime: write.mime,
          body: write.body,
          ...(write.threadId ? { threadId: write.threadId } : {}),
          ...(write.executionRunId ? { executionRunId: write.executionRunId } : {}),
        },
        update: {
          title: write.title,
          mime: write.mime,
          body: write.body,
          // Counted here rather than sent by the caller. The runtime does not
          // know what it revised — it knows only that it wrote the file again —
          // and a version the writer chooses is a version two writers disagree
          // about.
          version: { increment: 1 },
          ...(write.threadId ? { threadId: write.threadId } : {}),
          ...(write.executionRunId ? { executionRunId: write.executionRunId } : {}),
        },
        select: SUMMARY_SELECT,
      });
      return ok(summaryOf(row));
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.save', error));
    }
  }

  async get(
    scope: ArtifactScope & { artifactId: string },
  ): Promise<Result<Artifact | null, InfraError>> {
    try {
      const row = await this.db.artifact.findUnique({
        where: {
          companyId_userId_artifactId: {
            companyId: scope.companyId,
            userId: scope.userId,
            artifactId: scope.artifactId,
          },
        },
        select: { ...SUMMARY_SELECT, body: true },
      });
      if (!row) return ok(null);
      return ok({ ...summaryOf(row), body: row.body });
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.get', error));
    }
  }

  async list(
    scope: ArtifactScope & { threadId?: string },
    limit = 50,
  ): Promise<Result<ArtifactSummary[], InfraError>> {
    try {
      const rows = await this.db.artifact.findMany({
        where: {
          companyId: scope.companyId,
          userId: scope.userId,
          ...(scope.threadId ? { threadId: scope.threadId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: SUMMARY_SELECT,
      });
      return ok(rows.map(summaryOf));
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.list', error));
    }
  }
}
