-- Reproducible parsed-file projection. Original bytes and approval truth remain
-- in KnowledgeFileAsset/KnowledgeVersion; these rows can be rebuilt safely.
CREATE TYPE "KnowledgeFileDocumentStatus" AS ENUM (
  'processing',
  'ready',
  'failed',
  'superseded',
  'deleted'
);

CREATE TABLE "KnowledgeFileDocument" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "resourceVersion" INTEGER NOT NULL,
  "fileAssetId" TEXT NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "status" "KnowledgeFileDocumentStatus" NOT NULL DEFAULT 'processing',
  "pageCount" INTEGER,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "warningsJson" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "indexedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeFileDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeFileDocument_positive_version" CHECK ("resourceVersion" > 0),
  CONSTRAINT "KnowledgeFileDocument_nonnegative_counts" CHECK (
    "chunkCount" >= 0 AND "attempts" >= 0 AND ("pageCount" IS NULL OR "pageCount" >= 0)
  ),
  CONSTRAINT "KnowledgeFileDocument_sha256" CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "KnowledgeFileChunk" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "resourceVersion" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "pageStart" INTEGER,
  "pageEnd" INTEGER,
  "sectionPath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "text" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "charCount" INTEGER NOT NULL,
  "tokenEstimate" INTEGER NOT NULL,
  "searchVector" tsvector,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeFileChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeFileChunk_nonnegative_ordinal" CHECK ("ordinal" >= 0),
  CONSTRAINT "KnowledgeFileChunk_positive_sizes" CHECK (
    "charCount" > 0 AND "tokenEstimate" > 0 AND length("text") = "charCount"
  ),
  CONSTRAINT "KnowledgeFileChunk_page_range" CHECK (
    ("pageStart" IS NULL AND "pageEnd" IS NULL) OR
    ("pageStart" > 0 AND "pageEnd" >= "pageStart")
  ),
  CONSTRAINT "KnowledgeFileChunk_text_hash" CHECK ("textHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "KnowledgeFileDocument_fileAssetId_key"
  ON "KnowledgeFileDocument"("fileAssetId");
CREATE UNIQUE INDEX "KnowledgeFileDocument_resourceId_resourceVersion_key"
  ON "KnowledgeFileDocument"("resourceId", "resourceVersion");
CREATE INDEX "KnowledgeFileDocument_companyId_status_updatedAt_idx"
  ON "KnowledgeFileDocument"("companyId", "status", "updatedAt");
CREATE INDEX "KnowledgeFileDocument_resourceId_status_resourceVersion_idx"
  ON "KnowledgeFileDocument"("resourceId", "status", "resourceVersion");

CREATE UNIQUE INDEX "KnowledgeFileChunk_documentId_ordinal_key"
  ON "KnowledgeFileChunk"("documentId", "ordinal");
CREATE INDEX "KnowledgeFileChunk_companyId_resourceId_resourceVersion_ordinal_idx"
  ON "KnowledgeFileChunk"("companyId", "resourceId", "resourceVersion", "ordinal");
CREATE INDEX "KnowledgeFileChunk_documentId_pageStart_pageEnd_idx"
  ON "KnowledgeFileChunk"("documentId", "pageStart", "pageEnd");
CREATE INDEX "KnowledgeFileChunk_searchVector_idx"
  ON "KnowledgeFileChunk" USING GIN ("searchVector");

ALTER TABLE "KnowledgeFileDocument"
  ADD CONSTRAINT "KnowledgeFileDocument_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileDocument_resourceId_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "KnowledgeResource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileDocument_fileAssetId_fkey"
    FOREIGN KEY ("fileAssetId") REFERENCES "KnowledgeFileAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeFileChunk"
  ADD CONSTRAINT "KnowledgeFileChunk_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileChunk_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "KnowledgeFileDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
