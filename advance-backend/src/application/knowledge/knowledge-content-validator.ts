import { z } from 'zod';
import type { KnowledgeMutationAction, KnowledgeResourceKind } from '../../domain/knowledge/knowledge-mutation';
import type { ResolvedKnowledgeScope } from '../../domain/knowledge/knowledge-scope';
import { isSafePublishedMemoryFact } from './knowledge-fact-safety';
import { larkSkillEnglishOnlyError } from '../skills/lark-skill-language-policy';
import { unknownSkillToolIds } from '../skills/skill-tool-validation';
import { KnowledgeMutationError } from './knowledge-mutation.errors';

export const knowledgeMemoryContentSchema = z.object({
  facts: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
}).strict();

export const knowledgeSkillContentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(1_024).default(''),
  markdown: z.string().min(1).max(200_000),
  toolIds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
}).strict();

export const knowledgeFileContentSchema = z.object({
  assetId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64).toLowerCase(),
}).strict();

export interface KnowledgeFileAssetSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly uploadedById: string;
  readonly knowledgeResourceId: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly threatScanProvider: string | null;
  readonly threatScannedAt: Date | null;
  readonly status: 'staged' | 'deleting' | 'attached' | 'deleted';
  readonly expiresAt: Date;
}

export interface KnowledgeFileAssetReader {
  getForValidation(input: {
    readonly assetId: string;
    readonly companyId: string;
  }): Promise<KnowledgeFileAssetSnapshot | null>;
}

export interface KnowledgeContentValidator {
  validate(input: {
    readonly kind: KnowledgeResourceKind;
    readonly action: KnowledgeMutationAction;
    readonly content: unknown | null;
    readonly target: ResolvedKnowledgeScope;
    readonly requester: { readonly companyId: string; readonly userId: string };
    readonly existingResourceId: string | null;
  }): Promise<unknown | null>;
}

/**
 * Canonicalizes every knowledge payload before its hash is created.
 *
 * The hash shown to humans therefore covers the exact validated content that
 * can be applied. Projection workers repeat validation defensively, but they
 * never become a late policy gate.
 */
export class DefaultKnowledgeContentValidator implements KnowledgeContentValidator {
  constructor(
    private readonly fileAssets?: KnowledgeFileAssetReader,
    private readonly options: { readonly requireThreatScan: boolean } = { requireThreatScan: false },
  ) {}

  async validate(input: Parameters<KnowledgeContentValidator['validate']>[0]): Promise<unknown | null> {
    if (input.action === 'delete') return null;
    if (input.content === null) {
      throw new KnowledgeMutationError('invalid_request', `${input.action} requires content.`);
    }

    if (input.kind === 'memory') {
      const parsed = parseContent(knowledgeMemoryContentSchema, input.content, 'Invalid memory content.');
      if (parsed.facts.some(fact => !isSafePublishedMemoryFact(fact))) {
        throw new KnowledgeMutationError('invalid_request', 'Memory content contains credential-like secret material.');
      }
      return parsed;
    }

    if (input.kind === 'skill') {
      const parsed = parseContent(knowledgeSkillContentSchema, input.content, 'Invalid skill content.');
      const canonical = {
        name: parsed.name,
        slug: parsed.slug,
        summary: parsed.summary ?? '',
        markdown: parsed.markdown,
        toolIds: parsed.toolIds ?? [],
        tags: parsed.tags ?? [],
      };
      const unknownTools = unknownSkillToolIds(canonical.toolIds);
      if (unknownTools.length > 0) {
        throw new KnowledgeMutationError(
          'invalid_request',
          `Skill references unavailable tools: ${unknownTools.join(', ')}.`,
        );
      }
      const languageError = larkSkillEnglishOnlyError(canonical);
      if (languageError) throw new KnowledgeMutationError('invalid_request', languageError);
      return canonical;
    }

    const parsed = parseContent(knowledgeFileContentSchema, input.content, 'Invalid governed-file content.');
    if (!this.fileAssets) {
      throw new KnowledgeMutationError('storage_failure', 'Governed file storage is not configured.');
    }
    const asset = await this.fileAssets.getForValidation({
      assetId: parsed.assetId,
      companyId: input.requester.companyId,
    });
    if (!asset || asset.status === 'deleted' || asset.status === 'deleting') {
      throw new KnowledgeMutationError('not_found', 'The staged file does not exist.');
    }
    if (asset.uploadedById !== input.requester.userId) {
      throw new KnowledgeMutationError('permission_denied', 'Only the member who staged this file may publish it.');
    }
    if (this.options.requireThreatScan && (!asset.threatScanProvider || !asset.threatScannedAt)) {
      throw new KnowledgeMutationError(
        'storage_failure',
        'The staged file has no verified malware-scan evidence. Upload it again.',
      );
    }
    if (asset.status === 'staged' && asset.expiresAt.getTime() <= Date.now()) {
      throw new KnowledgeMutationError('conflict', 'The staged file expired. Upload it again.');
    }
    if (asset.knowledgeResourceId && asset.knowledgeResourceId !== input.existingResourceId) {
      throw new KnowledgeMutationError('conflict', 'This file is already attached to different governed knowledge.');
    }
    if (
      asset.fileName !== parsed.fileName
      || asset.mimeType !== parsed.mimeType
      || asset.sizeBytes !== parsed.sizeBytes
      || asset.sha256 !== parsed.sha256
    ) {
      throw new KnowledgeMutationError(
        'conflict',
        'The file metadata changed after staging. Use the exact backend-issued file descriptor.',
      );
    }
    return {
      assetId: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
  }
}

function parseContent<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new KnowledgeMutationError('invalid_request', message, parsed.error);
  return parsed.data;
}
