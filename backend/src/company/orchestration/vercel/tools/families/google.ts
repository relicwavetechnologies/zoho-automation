import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getLegacyToolMap, pickTools } from '../shared/legacy-factory';

export const buildGoogleTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => pickTools(getLegacyToolMap(runtime, hooks), [
  'googleWorkspace',
]);
