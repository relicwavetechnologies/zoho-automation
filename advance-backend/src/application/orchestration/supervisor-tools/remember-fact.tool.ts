import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { Mem0Service, MemoryScope } from '../../memory/mem0.service';

const schema = z.object({
  fact: z.string().min(1).describe('The fact to remember - concise, third-person, durable'),
  scope: z.enum(['user', 'department', 'company']).describe(
    'user = only for this person, department = shared with their team, company = org-wide',
  ),
});

export function createRememberFactTool(
  mem0: Mem0Service,
  runContext: RunContext,
) {
  return dynamicTool({
    description:
      'Store a durable fact in long-term memory. Use when the user states a preference, decision, correction, role, responsibility, or business fact worth remembering for future conversations.',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return 'error: fact and scope are required';

      const effectiveScope = resolveEffectiveScope(parsed.data.scope, runContext);
      await mem0.rememberExplicit({
        fact: parsed.data.fact,
        scope: effectiveScope,
        userId: String(runContext.userId),
        companyId: String(runContext.companyId),
        ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
      });

      const label = effectiveScope === 'company'
        ? 'the company'
        : effectiveScope === 'department'
          ? 'the team'
          : 'this user';
      return `Remembered for ${label}: "${parsed.data.fact}"`;
    },
  });
}

function resolveEffectiveScope(scope: MemoryScope, runContext: RunContext): MemoryScope {
  const role = String(runContext.companyRole);
  if (scope === 'company') {
    return ['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(role) ? 'company' : 'user';
  }
  if (scope === 'department') {
    const canWriteDepartment = ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].includes(role);
    return canWriteDepartment && runContext.departmentId ? 'department' : 'user';
  }
  return 'user';
}
