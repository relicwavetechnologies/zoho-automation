import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getLegacyToolMap, pickTools } from '../shared/legacy-factory';

export const buildWorkflowAuthoringTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => pickTools(getLegacyToolMap(runtime, hooks), [
  'workflowDraft',
  'workflowPlan',
  'workflowBuild',
  'workflowSave',
  'workflowSchedule',
  'workflowList',
  'workflowRun',
]);
