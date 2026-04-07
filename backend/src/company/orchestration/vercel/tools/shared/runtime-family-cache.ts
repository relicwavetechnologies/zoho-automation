import { buildRuntimeToolFamilies } from '../../runtime-tools';
import type { RuntimeVercelToolFamilies } from '../contracts';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

const cache = new WeakMap<
  VercelRuntimeRequestContext,
  WeakMap<VercelRuntimeToolHooks, RuntimeVercelToolFamilies>
>();

export const getRuntimeToolFamilies = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): RuntimeVercelToolFamilies => {
  const byHooks = cache.get(runtime);
  if (byHooks?.has(hooks)) {
    return byHooks.get(hooks)!;
  }

  const families = buildRuntimeToolFamilies(runtime, hooks);
  const nextByHooks = byHooks ?? new WeakMap<VercelRuntimeToolHooks, RuntimeVercelToolFamilies>();
  nextByHooks.set(hooks, families);
  if (!byHooks) {
    cache.set(runtime, nextByHooks);
  }

  return families;
};
