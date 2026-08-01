import { Prisma, type PrismaClient } from '../../generated/prisma';
import type {
  CanonicalKnowledgeDocumentChunk,
  KnowledgeDocumentRepository,
  KnowledgeFileDocumentSnapshot,
} from '../../application/knowledge/knowledge-document.repository';
import type {
  KnowledgeDocumentChunkInput,
  KnowledgeDocumentSemanticCandidate,
} from '../../application/knowledge/knowledge-document.port';

export class PrismaKnowledgeDocumentRepository implements KnowledgeDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async beginIndex(input: {
    companyId: string;
    resourceId: string;
    resourceVersion: number;
    fileAssetId: string;
    sourceSha256: string;
    mimeType: string;
    parserVersion: string;
  }): Promise<KnowledgeFileDocumentSnapshot> {
    const existing = await this.prisma.knowledgeFileDocument.findUnique({
      where: { resourceId_resourceVersion: {
        resourceId: input.resourceId,
        resourceVersion: input.resourceVersion,
      } },
    });
    if (existing && (
      existing.companyId !== input.companyId
      || existing.fileAssetId !== input.fileAssetId
      || existing.sourceSha256 !== input.sourceSha256
      || existing.mimeType !== input.mimeType
    )) throw new Error('An immutable file version cannot be re-indexed from different source bytes.');

    const row = existing
      ? await this.prisma.knowledgeFileDocument.update({
          where: { id: existing.id },
          data: {
            status: 'processing',
            parserVersion: input.parserVersion,
            attempts: { increment: 1 },
            lockedAt: new Date(),
            failureCode: null,
            failureMessage: null,
          },
          include: { resource: true },
        })
      : await this.prisma.knowledgeFileDocument.create({
          data: {
            ...input,
            status: 'processing',
            attempts: 1,
            lockedAt: new Date(),
          },
          include: { resource: true },
        });
    return toSnapshot(row);
  }

  async replaceChunks(input: {
    documentId: string;
    pageCount?: number;
    parserVersion: string;
    warnings: readonly string[];
    chunks: readonly KnowledgeDocumentChunkInput[];
  }): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const document = await tx.knowledgeFileDocument.findUnique({ where: { id: input.documentId } });
      if (!document || document.status !== 'processing') throw new Error('Document index lease is no longer active.');
      await tx.knowledgeFileChunk.deleteMany({ where: { documentId: document.id } });
      if (input.chunks.length > 0) {
        await tx.knowledgeFileChunk.createMany({
          data: input.chunks.map(chunk => ({
            companyId: document.companyId,
            documentId: document.id,
            resourceId: document.resourceId,
            resourceVersion: document.resourceVersion,
            ordinal: chunk.ordinal,
            pageStart: chunk.pageStart ?? null,
            pageEnd: chunk.pageEnd ?? null,
            sectionPath: [...chunk.sectionPath],
            text: chunk.text,
            textHash: chunk.textHash,
            charCount: chunk.charCount,
            tokenEstimate: chunk.tokenEstimate,
          })),
        });
        await tx.$executeRaw`
          UPDATE "KnowledgeFileChunk"
          SET "searchVector" = to_tsvector('simple', "text")
          WHERE "documentId" = ${document.id}
        `;
      }
      await tx.knowledgeFileDocument.update({
        where: { id: document.id },
        data: {
          parserVersion: input.parserVersion,
          pageCount: input.pageCount ?? null,
          chunkCount: input.chunks.length,
          warningsJson: input.warnings.length > 0
            ? [...input.warnings] as Prisma.InputJsonValue
            : Prisma.DbNull,
        },
      });
    });
  }

  async markReady(documentId: string): Promise<void> {
    const updated = await this.prisma.knowledgeFileDocument.updateMany({
      where: { id: documentId, status: 'processing' },
      data: {
        status: 'ready',
        indexedAt: new Date(),
        lockedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (updated.count !== 1) throw new Error('Document index lease was lost before completion.');
  }

  async markFailed(documentId: string, error: { code: string; message: string }): Promise<void> {
    await this.prisma.knowledgeFileDocument.updateMany({
      where: { id: documentId, status: 'processing' },
      data: {
        status: 'failed',
        lockedAt: null,
        failureCode: error.code.slice(0, 120),
        failureMessage: error.message.slice(0, 2_000),
      },
    });
  }

  async listOtherVersions(resourceId: string, currentVersion: number): Promise<readonly KnowledgeFileDocumentSnapshot[]> {
    const rows = await this.prisma.knowledgeFileDocument.findMany({
      where: { resourceId, resourceVersion: { not: currentVersion }, status: { not: 'deleted' } },
      include: { resource: true },
      orderBy: { resourceVersion: 'asc' },
    });
    return rows.map(toSnapshot);
  }

  async listByResource(resourceId: string): Promise<readonly KnowledgeFileDocumentSnapshot[]> {
    const rows = await this.prisma.knowledgeFileDocument.findMany({
      where: { resourceId },
      include: { resource: true },
      orderBy: { resourceVersion: 'asc' },
    });
    return rows.map(toSnapshot);
  }

  async markSuperseded(documentId: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await tx.knowledgeFileChunk.deleteMany({ where: { documentId } });
      await tx.knowledgeFileDocument.updateMany({
        where: { id: documentId, status: { not: 'deleted' } },
        data: { status: 'superseded', lockedAt: null },
      });
    });
  }

  async markDeleted(documentId: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await tx.knowledgeFileChunk.deleteMany({ where: { documentId } });
      await tx.knowledgeFileDocument.updateMany({
        where: { id: documentId },
        data: { status: 'deleted', lockedAt: null },
      });
    });
  }

  async keywordSearch(input: {
    companyId: string;
    userId: string;
    departmentIds: readonly string[];
    query: string;
    limit: number;
  }): Promise<readonly KnowledgeDocumentSemanticCandidate[]> {
    const departmentClause = input.departmentIds.length > 0
      ? Prisma.sql`("resource"."scope" = 'department' AND "resource"."departmentId" IN (${Prisma.join(input.departmentIds)}))`
      : Prisma.sql`FALSE`;
    const rows = await this.prisma.$queryRaw<Array<{
      resourceId: string;
      resourceVersion: number;
      chunkOrdinal: number;
      scope: 'personal' | 'department' | 'company';
      departmentName: string | null;
      score: number;
    }>>(Prisma.sql`
      SELECT
        "chunk"."resourceId" AS "resourceId",
        "chunk"."resourceVersion" AS "resourceVersion",
        "chunk"."ordinal" AS "chunkOrdinal",
        "resource"."scope"::text AS "scope",
        "department"."name" AS "departmentName",
        ts_rank_cd("chunk"."searchVector", websearch_to_tsquery('simple', ${input.query}))::float8 AS "score"
      FROM "KnowledgeFileChunk" AS "chunk"
      JOIN "KnowledgeFileDocument" AS "document" ON "document"."id" = "chunk"."documentId"
      JOIN "KnowledgeResource" AS "resource" ON "resource"."id" = "chunk"."resourceId"
      LEFT JOIN "Department" AS "department" ON "department"."id" = "resource"."departmentId"
      WHERE "chunk"."companyId" = ${input.companyId}
        AND "document"."status" = 'ready'
        AND "resource"."companyId" = ${input.companyId}
        AND "resource"."kind" = 'file'
        AND "resource"."status" = 'active'
        AND "resource"."currentVersion" = "chunk"."resourceVersion"
        AND (
          "resource"."scope" = 'company'
          OR ("resource"."scope" = 'personal' AND "resource"."ownerUserId" = ${input.userId})
          OR ${departmentClause}
        )
        AND "chunk"."searchVector" @@ websearch_to_tsquery('simple', ${input.query})
      ORDER BY "score" DESC, "chunk"."resourceId" ASC, "chunk"."ordinal" ASC
      LIMIT ${Math.max(1, Math.min(input.limit, 100))}
    `);
    return rows.map(row => ({
      resourceId: row.resourceId,
      resourceVersion: row.resourceVersion,
      chunkOrdinal: row.chunkOrdinal,
      scope: row.scope,
      score: Number(row.score),
      ...(row.departmentName ? { departmentName: row.departmentName } : {}),
    }));
  }

  async hydrateAuthorized(input: {
    companyId: string;
    userId: string;
    departmentIds: readonly string[];
    candidates: readonly KnowledgeDocumentSemanticCandidate[];
  }): Promise<readonly CanonicalKnowledgeDocumentChunk[]> {
    if (input.candidates.length === 0) return [];
    const rows = await this.prisma.knowledgeFileChunk.findMany({
      where: {
        companyId: input.companyId,
        OR: input.candidates.map(candidate => ({
          resourceId: candidate.resourceId,
          resourceVersion: candidate.resourceVersion,
          ordinal: candidate.chunkOrdinal,
        })),
        document: {
          status: 'ready',
          resource: {
            companyId: input.companyId,
            kind: 'file',
            status: 'active',
            OR: [
              { scope: 'company' },
              { scope: 'personal', ownerUserId: input.userId },
              ...(input.departmentIds.length > 0
                ? [{ scope: 'department' as const, departmentId: { in: [...input.departmentIds] } }]
                : []),
            ],
          },
        },
      },
      include: {
        document: {
          include: {
            fileAsset: { select: { fileName: true } },
            resource: { include: { department: { select: { name: true } } } },
          },
        },
      },
    });
    const byKey = new Map(rows.flatMap(row => {
      const resource = row.document.resource;
      if (resource.currentVersion !== row.resourceVersion) return [];
      return [[candidateKey(row), row] as const];
    }));
    return input.candidates.flatMap(candidate => {
      const row = byKey.get(candidateKey(candidate));
      if (!row) return [];
      const resource = row.document.resource;
      if (resource.scope !== candidate.scope) return [];
      return [{
        resourceId: row.resourceId,
        resourceVersion: row.resourceVersion,
        chunkOrdinal: row.ordinal,
        scope: resource.scope,
        ...(resource.department?.name ? { departmentName: resource.department.name } : {}),
        fileName: row.document.fileAsset.fileName,
        text: row.text,
        ...(row.pageStart === null ? {} : { pageStart: row.pageStart }),
        ...(row.pageEnd === null ? {} : { pageEnd: row.pageEnd }),
        sectionPath: row.sectionPath,
        score: candidate.score,
      }];
    });
  }
}

type DocumentWithResource = Prisma.KnowledgeFileDocumentGetPayload<{ include: { resource: true } }>;

function toSnapshot(row: DocumentWithResource): KnowledgeFileDocumentSnapshot {
  return {
    id: row.id,
    companyId: row.companyId,
    resourceId: row.resourceId,
    resourceVersion: row.resourceVersion,
    fileAssetId: row.fileAssetId,
    sourceSha256: row.sourceSha256,
    mimeType: row.mimeType,
    status: row.status,
    chunkCount: row.chunkCount,
    scope: row.resource.scope,
    ownerUserId: row.resource.ownerUserId,
    departmentId: row.resource.departmentId,
  };
}

function candidateKey(value: { resourceId: string; resourceVersion: number; chunkOrdinal?: number; ordinal?: number }): string {
  return `${value.resourceId}:${value.resourceVersion}:${value.chunkOrdinal ?? value.ordinal}`;
}
