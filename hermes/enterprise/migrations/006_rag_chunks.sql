-- Hermes-owned RAG chunk store (pgvector). The runtime owns its retrieval data:
-- it does NOT depend on advance-backend's external Qdrant cluster. Document
-- chunks + their embeddings live here, in the same Postgres Hermes already owns.
--
-- Embeddings are gemini-embedding-001 (3072-dim). pgvector's ivfflat/hnsw cap at
-- 2000 dims for the `vector` type, but `halfvec` hnsw supports up to 4000 — so we
-- index the cosine distance over an on-the-fly halfvec cast of the 3072-d column.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "HermesRagChunk" (
  "id"                     TEXT PRIMARY KEY,
  "companyId"              TEXT NOT NULL,
  "sourceType"             TEXT NOT NULL DEFAULT 'file_document',
  "sourceId"               TEXT NOT NULL,
  "chunkIndex"             INTEGER NOT NULL,
  "documentKey"            TEXT NOT NULL,
  "fileAssetId"            TEXT NULL,
  "ownerUserId"            TEXT NULL,
  "visibility"             TEXT NOT NULL DEFAULT 'shared',   -- personal | shared | public
  "allowedRoles"           JSONB NOT NULL DEFAULT '[]'::jsonb,
  "title"                  TEXT NULL,
  "chunkText"              TEXT NOT NULL,                    -- text that was embedded
  "rawChunkText"           TEXT NULL,                        -- original text for citations
  "sectionPath"            JSONB NOT NULL DEFAULT '[]'::jsonb,
  "contentHash"            TEXT NOT NULL,
  "embedding"              vector(3072) NOT NULL,
  "payload"                JSONB NOT NULL DEFAULT '{}'::jsonb,
  "embeddingSchemaVersion" TEXT NOT NULL DEFAULT 'hermes-rag-v1',
  "sourceUpdatedAt"        TIMESTAMPTZ NULL,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent re-ingest: one live row per (company, source, chunk).
CREATE UNIQUE INDEX IF NOT EXISTS "HermesRagChunk_identity_idx"
  ON "HermesRagChunk" ("companyId", "sourceType", "sourceId", "chunkIndex");

CREATE INDEX IF NOT EXISTS "HermesRagChunk_company_idx"
  ON "HermesRagChunk" ("companyId", "sourceType");
CREATE INDEX IF NOT EXISTS "HermesRagChunk_file_idx"
  ON "HermesRagChunk" ("companyId", "fileAssetId");

-- ANN index over cosine distance (halfvec supports the 3072-d vectors).
CREATE INDEX IF NOT EXISTS "HermesRagChunk_embedding_hnsw"
  ON "HermesRagChunk" USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops);
