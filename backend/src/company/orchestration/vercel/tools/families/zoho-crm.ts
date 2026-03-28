import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';
import { getLegacyToolMap, pickTools } from '../shared/legacy-factory';
import { zohoRateLimitService } from '../../../../integrations/zoho/zoho-rate-limit.service';

export const buildZohoCrmTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
): Record<string, any> => {
  const tools = pickTools(getLegacyToolMap(runtime, hooks), ['zoho']);
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
