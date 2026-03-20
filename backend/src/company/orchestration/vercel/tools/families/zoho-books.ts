import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getLegacyToolMap, pickTools } from '../shared/legacy-factory';

export const buildZohoBooksTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => pickTools(getLegacyToolMap(runtime, hooks), [
  'booksRead',
  'booksWrite',
]);
