import { HttpException } from '../../core/http-exception';
import { AI_CONTROL_TARGET_MAP, AI_CONTROL_TARGETS, AI_MODEL_CATALOG, AI_MODEL_CATALOG_MAP, AI_THINKING_LEVELS, isAiThinkingLevel, type AiControlTargetKey, type AiModelProvider, type AiThinkingLevel } from './catalog';
import { aiModelTargetConfigRepository, type AiModelTargetConfigRow } from './repository';

export type AiModelTargetOverrideDTO = {
  provider: AiModelProvider;
  modelId: string;
  thinkingLevel?: AiThinkingLevel;
  updatedBy: string;
  updatedAt: string;
};

export type AiModelTargetResolvedDTO = {
  targetKey: AiControlTargetKey;
  label: string;
  description: string;
  engine: 'mastra' | 'langgraph';
  kind: 'supervisor' | 'specialist' | 'router' | 'planner' | 'synthesis';
  effectiveProvider: AiModelProvider;
  effectiveModelId: string;
  effectiveThinkingLevel?: AiThinkingLevel;
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
        source: 'default',
      };
    }

    const provider = normalizeProvider(row.provider);
    const thinkingLevel = normalizeThinkingLevel(row.thinkingLevel);
    return {
      targetKey,
      label: target.label,
      description: target.description,
      engine: target.engine,
      kind: target.kind,
      effectiveProvider: provider,
      effectiveModelId: row.modelId,
      effectiveThinkingLevel: thinkingLevel,
      source: 'override',
      override: toOverride(row),
    };
  }

  private validateSelection(input: {
    targetKey: AiControlTargetKey;
    provider: AiModelProvider;
    modelId: string;
    thinkingLevel?: AiThinkingLevel;
  }): void {
    if (!AI_CONTROL_TARGET_MAP.has(input.targetKey)) {
      throw new HttpException(404, `Unknown AI model target: ${input.targetKey}`);
    }

    const model = AI_MODEL_CATALOG_MAP.get(`${input.provider}:${input.modelId}`);
    if (!model) {
      throw new HttpException(400, `Model ${input.provider}/${input.modelId} is not in the approved catalog`);
    }

    if (input.thinkingLevel && input.provider !== 'google') {
      throw new HttpException(400, 'Thinking level is only supported for Google Gemini targets in this control plane');
    }

    if (input.thinkingLevel && !model.supportsThinking) {
      throw new HttpException(400, `Model ${input.modelId} does not support thinking level controls`);
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
    updatedBy: string;
  }): Promise<AiModelTargetResolvedDTO> {
    const provider = normalizeProvider(input.provider.trim().toLowerCase());
    const thinkingLevel = normalizeThinkingLevel(input.thinkingLevel);
    const modelId = input.modelId.trim();
    if (!modelId) {
      throw new HttpException(400, 'modelId is required');
    }

    this.validateSelection({
      targetKey: input.targetKey,
      provider,
      modelId,
      thinkingLevel,
    });

    const row = await this.repository.upsert({
      targetKey: input.targetKey,
      provider,
      modelId,
      thinkingLevel: thinkingLevel ?? null,
      updatedBy: input.updatedBy,
    });
    return this.resolveFromRow(input.targetKey, row);
  }
}

export const aiModelControlService = new AiModelControlService();
