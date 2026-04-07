import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getRuntimeToolFamilies } from '../shared/runtime-family-cache';

export const buildLarkMessagingTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => getRuntimeToolFamilies(runtime, hooks).larkMessaging;
