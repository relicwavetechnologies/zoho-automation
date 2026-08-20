import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type {
  Artifact,
  ArtifactPublicationWrite,
  ArtifactSummary,
  ArtifactWrite,
} from '../../domain/artifact/artifact';
import { isArtifactMime } from '../../domain/artifact/artifact';
import { ARTIFACT_PREVIEW_SOURCE_CHARS, previewOf } from '../../domain/artifact/preview';

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
  markPublished(
    scope: ArtifactScope & { artifactId: string },
    publication: ArtifactPublicationWrite,
  ): Promise<Result<ArtifactSummary, InfraError>>;
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
  publishedUrl: string | null;
  publishedAt: Date | null;
  publishDeploymentId: string | null;
  preview: string;
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
    ...(row.publishedUrl ? { publishedUrl: row.publishedUrl } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    ...(row.publishDeploymentId ? { publishDeploymentId: row.publishDeploymentId } : {}),
    preview: row.preview,
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
  publishedUrl: true,
  publishedAt: true,
  publishDeploymentId: true,
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
          publishedUrl: null,
          publishedAt: null,
          publishGateHash: null,
          publishDeploymentId: null,
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
          publishedUrl: null,
          publishedAt: null,
          publishGateHash: null,
          publishDeploymentId: null,
        },
        select: SUMMARY_SELECT,
      });
      // From what was just written rather than read back: the row we hold is
      // the row we sent, and a second trip for 400 characters we already have
      // would be a query bought with nothing.
      return ok(summaryOf({ ...row, preview: previewOf(write.body, write.mime) }));
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.save', error));
    }
  }

  async markPublished(
    scope: ArtifactScope & { artifactId: string },
    publication: ArtifactPublicationWrite,
  ): Promise<Result<ArtifactSummary, InfraError>> {
    try {
      const row = await this.db.artifact.update({
        where: {
          companyId_userId_artifactId: {
            companyId: scope.companyId,
            userId: scope.userId,
            artifactId: scope.artifactId,
          },
        },
        data: {
          publishedUrl: publication.publishedUrl,
          publishedAt: new Date(publication.publishedAt),
          publishGateHash: publication.publishGateHash,
          publishDeploymentId: publication.publishDeploymentId,
        },
        select: SUMMARY_SELECT,
      });
      return ok(summaryOf({ ...row, preview: '' }));
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.markPublished', error));
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
      return ok({ ...summaryOf({ ...row, preview: previewOf(row.body, row.mime) }), body: row.body });
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.get', error));
    }
  }

  async list(
    scope: ArtifactScope & { threadId?: string },
    limit = 50,
  ): Promise<Result<ArtifactSummary[], InfraError>> {
    try {
      /*
       * Raw for one reason: `left(body, …)`.
       *
       * Prisma can select a column or not select it, and a list that wants the
       * opening of fifty documents would otherwise pull fifty whole ones — up
       * to `maxBodyChars` each — to keep a few lines of each. Postgres cuts
       * them where they lie. Everything else about the query is what `findMany`
       * was doing, and it still lands on the `[companyId, userId, updatedAt]`
       * index.
       *
       * The `::int` is not decoration: Prisma binds a JS number as `bigint`,
       * and `left(text, bigint)` is not a function Postgres has.
       */
      const rows = await this.db.$queryRaw<(Omit<Row, 'preview'> & { head: string })[]>(Prisma.sql`
        SELECT "artifactId", "title", "mime", "version", "threadId",
          "createdAt", "updatedAt", "publishedUrl", "publishedAt", "publishDeploymentId",
          left("body", ${ARTIFACT_PREVIEW_SOURCE_CHARS}::int) AS "head"
        FROM "Artifact"
        WHERE "companyId" = ${scope.companyId} AND "userId" = ${scope.userId}
          ${scope.threadId ? Prisma.sql`AND "threadId" = ${scope.threadId}` : Prisma.empty}
        ORDER BY "updatedAt" DESC
        LIMIT ${limit}`);
      return ok(rows.map(row => summaryOf({ ...row, preview: previewOf(row.head, row.mime) })));
    } catch (error) {
      return err(wrapInfra('prisma', 'artifact.list', error));
    }
  }
}
