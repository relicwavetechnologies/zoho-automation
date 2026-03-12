import { HttpException } from '../../core/http-exception';
import { AI_CONTROL_TARGET_MAP, AI_CONTROL_TARGETS, AI_MODEL_CATALOG, AI_MODEL_CATALOG_MAP, AI_THINKING_LEVELS, isAiThinkingLevel, type AiControlTargetKey, type AiModelProvider, type AiThinkingLevel } from './catalog';
import { aiModelTargetConfigRepository, type AiModelTargetConfigRow } from './repository';

export type AiModelTargetOverrideDTO = {
  provider: AiModelProvider;
  modelId: string;
  thinkingLevel?: AiThinkingLevel;
  fastProvider?: AiModelProvider;
  fastModelId?: string;
  fastThinkingLevel?: AiThinkingLevel;
  updatedBy: string;
  updatedAt: string;
};

export type AiModelTargetResolvedDTO = {
  targetKey: AiControlTargetKey;
  label: string;
  description: string;
  engine: 'mastra' | 'langgraph';
  kind: 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis' | 'ack';
  effectiveProvider: AiModelProvider;
  effectiveModelId: string;
  effectiveThinkingLevel?: AiThinkingLevel;
  fastEffectiveProvider?: AiModelProvider;
  fastEffectiveModelId?: string;
  fastEffectiveThinkingLevel?: AiThinkingLevel;
  source: 'default' | 'override';
  override?: AiModelTargetOverrideDTO;
};

export type AiModelControlPlaneDTO = {
  thinkingLevels: AiThinkingLevel[];
  catalog: typeof AI_MODEL_CATALOG;
  targets: AiModelTargetResolvedDTO[];
};

const normalizeProvider = (value: string): AiModelProvider => {
  if (value === 'google' || value === 'openai') {
    return value;
  }
  throw new HttpException(400, `Unsupported provider: ${value}`);
};

const normalizeThinkingLevel = (value?: string | null): AiThinkingLevel | undefined => {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!isAiThinkingLevel(normalized)) {
    throw new HttpException(400, `Unsupported thinking level: ${value}`);
  }
  return normalized;
};

const toOverride = (row: AiModelTargetConfigRow): AiModelTargetOverrideDTO => ({
  provider: normalizeProvider(row.provider),
  modelId: row.modelId,
  thinkingLevel: normalizeThinkingLevel(row.thinkingLevel),
  fastProvider: row.fastProvider ? normalizeProvider(row.fastProvider) : undefined,
  fastModelId: row.fastModelId ?? undefined,
  fastThinkingLevel: normalizeThinkingLevel(row.fastThinkingLevel),
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

class AiModelControlService {
  constructor(private readonly repository = aiModelTargetConfigRepository) {}

  private resolveFromRow(targetKey: AiControlTargetKey, row?: AiModelTargetConfigRow | null): AiModelTargetResolvedDTO {
    const target = AI_CONTROL_TARGET_MAP.get(targetKey);
    if (!target) {
      throw new HttpException(404, `Unknown AI model target: ${targetKey}`);
    }

    if (!row) {
      return {
        targetKey,
        label: target.label,
        description: target.description,
        engine: target.engine,
        kind: target.kind,
        effectiveProvider: target.defaultProvider,
        effectiveModelId: target.defaultModelId,
        effectiveThinkingLevel: target.defaultThinkingLevel,
        fastEffectiveProvider: target.fastDefaultProvider,
        fastEffectiveModelId: target.fastDefaultModelId,
        fastEffectiveThinkingLevel: target.fastDefaultThinkingLevel,
        source: 'default',
      };
    }

    const provider = normalizeProvider(row.provider);
    const thinkingLevel = normalizeThinkingLevel(row.thinkingLevel);
    const fastProvider = row.fastProvider ? normalizeProvider(row.fastProvider) : undefined;
    const fastThinkingLevel = normalizeThinkingLevel(row.fastThinkingLevel);

    // If fast params are not set in the override, fallback to target defaults
    const effectiveFastProvider = fastProvider ?? target.fastDefaultProvider;
    const effectiveFastModelId = row.fastModelId ?? target.fastDefaultModelId;
    const effectiveFastThinkingLevel = row.fastModelId ? fastThinkingLevel : (target.fastDefaultThinkingLevel ?? undefined);

    return {
      targetKey,
      label: target.label,
      description: target.description,
      engine: target.engine,
      kind: target.kind,
      effectiveProvider: provider,
      effectiveModelId: row.modelId,
      effectiveThinkingLevel: thinkingLevel,
      fastEffectiveProvider: effectiveFastProvider,
      fastEffectiveModelId: effectiveFastModelId,
      fastEffectiveThinkingLevel: effectiveFastThinkingLevel,
      source: 'override',
      override: toOverride(row),
    };
  }

  private validateSelection(input: {
    targetKey: AiControlTargetKey;
    provider: AiModelProvider;
    modelId: string;
    thinkingLevel?: AiThinkingLevel;
    fastProvider?: AiModelProvider;
    fastModelId?: string;
    fastThinkingLevel?: AiThinkingLevel;
  }): void {
    if (!AI_CONTROL_TARGET_MAP.has(input.targetKey)) {
      throw new HttpException(404, `Unknown AI model target: ${input.targetKey}`);
    }

    const validateModelContext = (prov: AiModelProvider, modId: string, thinkLevel?: string) => {
      const model = AI_MODEL_CATALOG_MAP.get(`${prov}:${modId}`);
      if (!model) {
        throw new HttpException(400, `Model ${prov}/${modId} is not in the approved catalog`);
      }

      if (thinkLevel && prov !== 'google') {
        throw new HttpException(400, 'Thinking level is only supported for Google Gemini targets in this control plane');
      }

      if (thinkLevel && !model.supportsThinking) {
        throw new HttpException(400, `Model ${modId} does not support thinking level controls`);
      }
    };

    validateModelContext(input.provider, input.modelId, input.thinkingLevel);
    if (input.fastProvider && input.fastModelId) {
      validateModelContext(input.fastProvider, input.fastModelId, input.fastThinkingLevel);
    }
  }

  async listControlPlane(): Promise<AiModelControlPlaneDTO> {
    const rows = await this.repository.listAll();
    const rowMap = new Map(rows.map((row) => [row.targetKey, row]));

    return {
      thinkingLevels: AI_THINKING_LEVELS,
      catalog: AI_MODEL_CATALOG,
      targets: AI_CONTROL_TARGETS.map((target) =>
        this.resolveFromRow(target.key, rowMap.get(target.key)),
      ),
    };
  }

  async resolveTarget(targetKey: AiControlTargetKey): Promise<AiModelTargetResolvedDTO> {
    const row = await this.repository.findByTargetKey(targetKey);
    return this.resolveFromRow(targetKey, row);
  }

  async updateTarget(input: {
    targetKey: AiControlTargetKey;
    provider: string;
    modelId: string;
    thinkingLevel?: string | null;
    fastProvider?: string | null;
    fastModelId?: string | null;
    fastThinkingLevel?: string | null;
    updatedBy: string;
  }): Promise<AiModelTargetResolvedDTO> {
    const provider = normalizeProvider(input.provider.trim().toLowerCase());
    const thinkingLevel = normalizeThinkingLevel(input.thinkingLevel);
    const modelId = input.modelId.trim();
    if (!modelId) {
      throw new HttpException(400, 'modelId is required');
    }

    const fastProvider = input.fastProvider ? normalizeProvider(input.fastProvider.trim().toLowerCase()) : undefined;
    const fastThinkingLevel = normalizeThinkingLevel(input.fastThinkingLevel);
    const fastModelId = input.fastModelId?.trim();

    this.validateSelection({
      targetKey: input.targetKey,
      provider,
      modelId,
      thinkingLevel,
      fastProvider,
      fastModelId,
      fastThinkingLevel,
    });

    const row = await this.repository.upsert({
      targetKey: input.targetKey,
      provider,
      modelId,
      thinkingLevel: thinkingLevel ?? null,
      fastProvider: fastProvider ?? null,
      fastModelId: fastModelId ?? null,
      fastThinkingLevel: fastThinkingLevel ?? null,
      updatedBy: input.updatedBy,
    });

    return this.resolveFromRow(input.targetKey, row);
  }
}

export const aiModelControlService = new AiModelControlService();
