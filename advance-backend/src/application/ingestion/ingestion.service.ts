import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';
import type { CloudinaryAdapter } from '../../infrastructure/cloudinary/cloudinary.adapter';
import type { EmbeddingService } from '../../infrastructure/ai/embedding/embedding.service';
import type { QdrantAdapter } from '../../infrastructure/ai/vector/qdrant.adapter';
import type { FileAssetRepository } from '../../infrastructure/persistence/file-asset.repository';
import type { VectorDocumentRepository } from '../../infrastructure/persistence/vector-document.repository';
import type { FileAccessPolicyRepository } from '../../infrastructure/persistence/file-access-policy.repository';
import { extractFromBuffer } from './text-extraction/extract';
import { chooseFileChunkingPlan } from './chunking/plans';
import { buildIndexedFileChunks } from './chunking/chunker';
import { ACTIVE_EMBEDDING_SCHEMA_VERSION } from '../../infrastructure/ai/vector/types';
import type { VectorUpsertInput } from '../../infrastructure/ai/vector/types';
import { createHash } from 'crypto';

export interface IngestBufferInput {
  companyId:       string;
  uploaderUserId:  string;
  uploaderChannel: string;
  fileName:        string;
  mimeType:        string;
  buffer:          Buffer;
  allowedRoles?:   string[];
  visibility?:     'personal' | 'shared' | 'public';
}

export interface IngestResult {
  fileAssetId:   string;
  chunkCount:    number;
  documentClass: string;
  cloudinaryUrl: string;
  textPreview?:  string;
}

export class IngestionService {
  private readonly log: Logger;

  constructor(
    private readonly env:           TypedEnv,
    private readonly cloudinary:    CloudinaryAdapter,
    private readonly embedding:     EmbeddingService,
    private readonly qdrant:        QdrantAdapter,
    private readonly fileAssetRepo: FileAssetRepository,
    private readonly vectorDocRepo: VectorDocumentRepository,
    private readonly policyRepo:    FileAccessPolicyRepository,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'ingestion' });
  }

  async ingestBuffer(input: IngestBufferInput): Promise<IngestResult> {
    const { companyId, uploaderUserId, uploaderChannel, fileName, mimeType, buffer } = input;

    // 1. Upload to Cloudinary (non-fatal — large files may exceed plan limits)
    let cloudResult: { publicId: string; secureUrl: string } | null = null;
    let cloudinaryFailed = false;
    try {
      cloudResult = await this.cloudinary.uploadBuffer({
        buffer,
        mimeType,
        fileName,
        folder:    `company/${companyId}/documents`,
        companyId,
        assetId:   `${companyId}_${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`,
      });
    } catch (e) {
      cloudinaryFailed = true;
      this.log.warn('ingestion.cloudinary_upload.failed', {
        fileName, companyId, sizeBytes: buffer.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 2. Create FileAsset record (status: pending)
    const createResult = await this.fileAssetRepo.create({
      companyId,
      uploaderUserId,
      uploaderChannel,
      fileName,
      mimeType,
      sizeBytes:              buffer.length,
      cloudinaryPublicId:     cloudResult?.publicId ?? '',
      cloudinaryUrl:          cloudResult?.secureUrl ?? '',
      cloudinaryResourceType: cloudResult ? (mimeType.startsWith('image/') ? 'image' : 'raw') : '',
    });
    if (!createResult.ok) {
      throw new Error(`FileAsset.create failed: ${createResult.error.message}`);
    }
    const fileAsset = createResult.value;
    await this.fileAssetRepo.setStatus(fileAsset.id, 'processing');

    try {
      // 3. Extract text
      const extracted = await extractFromBuffer(
        buffer,
        mimeType,
        this.env.GEMINI_API_KEY ?? this.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
        this.env.DOC_EXTRACT_MAX_WORDS,
        fileName,
        this.env.GEMINI_VISION_MODEL,
        {
          provider: this.env.IMAGE_OCR_PROVIDER,
          geminiApiKey: this.env.GEMINI_API_KEY ?? this.env.GOOGLE_GENERATIVE_AI_API_KEY,
          openrouterApiKey: this.env.OPENROUTER_API_KEY,
          visionModel: this.env.IMAGE_OCR_PROVIDER === 'openrouter'
            ? this.env.OPENROUTER_VISION_MODEL
            : this.env.GEMINI_VISION_MODEL,
          openrouterProviderOrder: this.env.OPENROUTER_PROVIDER_ORDER,
        },
      );

      // 4. Choose chunking plan
      const plan = chooseFileChunkingPlan({
        fileName,
        mimeType,
        text: extracted.text,
        advancedChunkingEnabled:     true,
        contextualEnrichmentEnabled: this.env.FILE_RAG_CHUNK_SEARCH_ENABLED,
      });

      // 5. Build indexed chunks
      const chunks = buildIndexedFileChunks({
        companyId,
        fileAssetId:    fileAsset.id,
        fileName,
        mimeType,
        sourceUrl:      cloudResult?.secureUrl ?? '',
        uploaderUserId,
        visibility:     input.visibility ?? 'personal',
        allowedRoles:   input.allowedRoles ?? [],
        text:           extracted.text,
        plan,
      });

      if (chunks.length === 0) {
        await this.fileAssetRepo.setStatus(fileAsset.id, 'done', 'No text extracted — file may be empty or unsupported.');
        return {
          fileAssetId: fileAsset.id,
          chunkCount: 0,
          documentClass: plan.documentClass,
          cloudinaryUrl: cloudResult?.secureUrl ?? '',
        };
      }

      // 6. Embed chunks in batches of 16
      const chunkTexts = chunks.map(c => ({ text: c.chunkText }));
      const embeddings = await this.embedding.embedDocuments(chunkTexts);

      // 7. Multimodal embedding for images (Gemini dense_mm_v1)
      let multimodalEmbedding: number[] | undefined;
      if (
        this.env.FILE_RAG_MULTIMODAL_ENABLED &&
        extracted.modality === 'image' &&
        extracted.imageBuffer
      ) {
        try {
          const mmResult = await this.embedding.embedMediaSummary({
            mimeType:      extracted.imageMime ?? mimeType,
            fileName,
            buffer:        extracted.imageBuffer,
            cloudinaryUrl: cloudResult?.secureUrl ?? '',
          });
          multimodalEmbedding = mmResult.embedding;
        } catch (e) {
          this.log.warn('ingestion.multimodal_embed_failed', { fileAssetId: fileAsset.id, error: String(e) });
        }
      }

      // 8. Upsert to Qdrant
      const qdrantInputs: VectorUpsertInput[] = chunks.map((chunk, i) => ({
        companyId,
        sourceType:             'file_document' as const,
        sourceId:               fileAsset.id,
        chunkIndex:             chunk.chunkIndex,
        contentHash:            createHash('sha256').update(chunk.chunkText).digest('hex'),
        visibility:             input.visibility ?? 'personal',
        ownerUserId:            uploaderUserId,
        fileAssetId:            fileAsset.id,
        allowedRoles:           input.allowedRoles ?? [],
        documentKey:            chunk.documentKey,
        title:                  chunk.title,
        content:                chunk.chunkText,
        sourceUpdatedAt:        chunk.sourceUpdatedAt,
        embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
        retrievalProfile:       'file' as const,
        denseEmbedding:         embeddings[i] ?? [],
        ...(i === 0 && multimodalEmbedding ? { multimodalEmbedding } : {}),
        payload:                chunk.payload,
      }));
      await this.qdrant.upsertVectors(qdrantInputs);

      // 9. Upsert to Postgres VectorDocument (for full-doc reassembly)
      await this.vectorDocRepo.upsertMany(chunks.map((chunk, i) => ({
        companyId,
        fileAssetId:            fileAsset.id,
        sourceType:             'file_document',
        sourceId:               fileAsset.id,
        chunkIndex:             chunk.chunkIndex,
        documentKey:            chunk.documentKey,
        contentHash:            createHash('sha256').update(chunk.chunkText).digest('hex'),
        visibility:             input.visibility ?? 'personal',
        ownerUserId:            uploaderUserId,
        chunkText:              chunk.chunkText,
        payload:                chunk.payload,
        embedding:              embeddings[i] ?? [],
        embeddingSchemaVersion: ACTIVE_EMBEDDING_SCHEMA_VERSION,
        retrievalProfile:       'file',
      })));

      // 10. Create access policies
      if (input.allowedRoles && input.allowedRoles.length > 0) {
        await this.policyRepo.createMany(
          input.allowedRoles.map(aiRole => ({
            fileAssetId: fileAsset.id,
            companyId,
            aiRole,
            canRead:   true,
            grantedBy: uploaderUserId,
          })),
        );
      }

      await this.fileAssetRepo.setStatus(
        fileAsset.id,
        'done',
        cloudinaryFailed ? 'Indexed but Cloudinary upload failed — file not downloadable via URL' : undefined,
      );

      if (cloudinaryFailed) {
        this.log.warn('ingestion.done_no_cdn', {
          fileAssetId: fileAsset.id, fileName,
          chunkCount: chunks.length, documentClass: plan.documentClass,
        });
      } else {
        this.log.info('ingestion.done', {
          fileAssetId: fileAsset.id, fileName,
          chunkCount: chunks.length, documentClass: plan.documentClass, strategy: plan.strategy,
        });
      }

      return {
        fileAssetId: fileAsset.id,
        chunkCount: chunks.length,
        documentClass: plan.documentClass,
        cloudinaryUrl: cloudResult?.secureUrl ?? '',
        textPreview: extracted.text.slice(0, 10_000),
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.log.error('ingestion.failed', { fileAssetId: fileAsset.id, fileName, error: errMsg });
      await this.fileAssetRepo.setStatus(fileAsset.id, 'failed', errMsg);
      throw e;
    }
  }

  /** Retry a failed ingestion: re-download from Cloudinary and re-ingest. */
  async retryFile(fileAssetId: string, companyId: string): Promise<void> {
    const findResult = await this.fileAssetRepo.findById(fileAssetId);
    if (!findResult.ok || !findResult.value) throw new Error('FileAsset not found');
    const asset = findResult.value;
    if (asset.companyId !== companyId) throw new Error('Forbidden');

    // Re-download buffer from Cloudinary URL
    const response = await fetch(asset.cloudinaryUrl);
    if (!response.ok) throw new Error(`Failed to re-download file: ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());

    const policies = await this.policyRepo.findByFileAsset(fileAssetId);
    const roles = policies.ok ? policies.value.map(p => p.aiRole) : [];

    await this.ingestBuffer({
      companyId,
      uploaderUserId:  asset.uploaderUserId,
      uploaderChannel: asset.uploaderChannel,
      fileName:        asset.fileName,
      mimeType:        asset.mimeType,
      buffer:          buf,
      allowedRoles:    roles,
      visibility:      'personal',
    });
  }

  /** Delete a file asset and all its vectors (Qdrant + Postgres). */
  async deleteFile(fileAssetId: string, companyId: string): Promise<void> {
    try {
      await this.qdrant.deleteBySource({ companyId, sourceType: 'file_document', sourceId: fileAssetId });
    } catch (e) {
      this.log.warn('ingestion.delete.qdrant_failed', { fileAssetId, error: String(e) });
    }
    await this.vectorDocRepo.deleteByFileAsset(fileAssetId);
    await this.fileAssetRepo.delete(fileAssetId);
  }
}
