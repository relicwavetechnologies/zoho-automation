import type { KnowledgeScopeRequest, KnowledgeScopeResolution } from '../../domain/knowledge/knowledge-scope';
import { resolveKnowledgeScope } from '../../domain/knowledge/knowledge-scope';
import type { ToolExecutionContext } from '../tools/tool.contract';

/** Resolve a model-suggested target only from backend-authenticated context. */
export function resolveToolKnowledgeScope(
  request: KnowledgeScopeRequest,
  ctx: Pick<ToolExecutionContext, 'runContext' | 'perm'>,
): KnowledgeScopeResolution {
  return resolveKnowledgeScope(request, {
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    ...(ctx.runContext.departmentId
      ? { selectedDepartmentId: ctx.runContext.departmentId }
      : {}),
    authorizedDepartments: ctx.perm.department
      ? [{ id: ctx.perm.department.id, name: ctx.perm.department.name }]
      : [],
  });
}
