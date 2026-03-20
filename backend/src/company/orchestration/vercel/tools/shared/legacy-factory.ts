import { createVercelDesktopTools as createLegacyVercelDesktopTools } from '../../legacy-tools';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

type ToolMap = Record<string, any>;

const cache = new WeakMap<VercelRuntimeRequestContext, WeakMap<VercelRuntimeToolHooks, ToolMap>>();

export const getLegacyToolMap = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): ToolMap => {
  const byHooks = cache.get(runtime);
  if (byHooks?.has(hooks)) {
    return byHooks.get(hooks)!;
  }

  const toolMap = createLegacyVercelDesktopTools(runtime, hooks);
  const nextByHooks = byHooks ?? new WeakMap<VercelRuntimeToolHooks, ToolMap>();
  nextByHooks.set(hooks, toolMap);
  if (!byHooks) {
    cache.set(runtime, nextByHooks);
  }
  return toolMap;
};

export const pickTools = (
  toolMap: ToolMap,
  toolNames: string[],
): ToolMap => Object.fromEntries(
  toolNames
    .map((toolName) => [toolName, toolMap[toolName]] as const)
    .filter(([, toolDef]) => Boolean(toolDef)),
);
