import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getRuntimeToolFamilies } from '../shared/runtime-family-cache';
import { zohoRateLimitService } from '../../../../integrations/zoho/zoho-rate-limit.service';

export const buildZohoBooksTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => {
  const tools = getRuntimeToolFamilies(runtime, hooks).zohoBooks;
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, toolDef]) => [
      toolName,
      {
        ...toolDef,
        execute: async (input: unknown, options?: unknown) =>
          zohoRateLimitService.runWithContext(
            {
              companyId: runtime.companyId,
              userId: runtime.userId,
              departmentId: runtime.departmentId,
              departmentRoleSlug: runtime.departmentRoleSlug,
              config: runtime.departmentZohoRateLimitConfig,
            },
            () => toolDef.execute(input, options),
          ),
      },
    ]),
  );
};
