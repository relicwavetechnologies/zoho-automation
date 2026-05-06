import type { ToolSet } from 'ai';
import type { Tool as AppTool } from './tool.contract';
import { toAISdkTools, type AdapterContext } from './ai-sdk-adapter';
import type { Logger } from '../../../shared/logger';

export interface ToolResolveResult {
  readonly appTools: AppTool<unknown, unknown>[];
  readonly missingToolIds: string[];
}

export function resolveAppToolsById(
  toolIds: readonly string[],
  allTools: ReadonlyArray<AppTool<unknown, unknown>>,
  logger?: Logger,
): ToolResolveResult {
  const requested = [...new Set(toolIds)];
  const toolById = new Map(allTools.map(t => [String(t.id), t]));
  const appTools: AppTool<unknown, unknown>[] = [];
  const missingToolIds: string[] = [];

  for (const id of requested) {
    const tool = toolById.get(id);
    if (tool) {
      appTools.push(tool);
      continue;
    }
    missingToolIds.push(id);
    logger?.warn('tool_resolver.unknown_tool_id', { toolId: id });
  }

  return { appTools, missingToolIds };
}

export function resolveToolsById(
  toolIds: readonly string[],
  allTools: ReadonlyArray<AppTool<unknown, unknown>>,
  adapterCtx: AdapterContext,
): ToolSet {
  const { appTools } = resolveAppToolsById(toolIds, allTools, adapterCtx.logger);
  return toAISdkTools(appTools, adapterCtx);
}

export function resolveToolsByIdFiltered(
  toolIds: readonly string[],
  allowedToolIds: ReadonlySet<string>,
  allTools: ReadonlyArray<AppTool<unknown, unknown>>,
  adapterCtx: AdapterContext,
): ToolSet {
  const filtered = toolIds.filter(id => allowedToolIds.has(id));
  const skipped = toolIds.filter(id => !allowedToolIds.has(id));
  for (const id of skipped) {
    adapterCtx.logger.warn('tool_resolver.disallowed_tool_id', { toolId: id });
  }
  return resolveToolsById(filtered, allTools, adapterCtx);
}
