import { z } from 'zod';
import type { CompanyId, DepartmentId, UserId } from '../../shared/ids';

/**
 * The only durable knowledge scopes in Divo.
 *
 * `draft` and `session` are lifecycle states, not scopes. Publishing to both a
 * department and its company is represented by two resolved targets so each
 * target keeps an independent policy and approval receipt.
 */
export const KnowledgeScopeKindSchema = z.enum(['personal', 'department', 'company']);

export type KnowledgeScopeKind = z.infer<typeof KnowledgeScopeKindSchema>;

/**
 * Agent-facing requests never accept companyId or userId. Those values come
 * from the authenticated backend principal, preventing cross-tenant or
 * cross-user targeting through model-generated arguments.
 */
export const KnowledgeScopeRequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal') }).strict(),
  z.object({
    scope: z.literal('department'),
    departmentId: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  z.object({ scope: z.literal('company') }).strict(),
]);

export type KnowledgeScopeRequest = z.infer<typeof KnowledgeScopeRequestSchema>;

export type ResolvedKnowledgeScope =
  | {
      readonly scope: 'personal';
      readonly companyId: CompanyId;
      readonly userId: UserId;
    }
  | {
      readonly scope: 'department';
      readonly companyId: CompanyId;
      readonly departmentId: DepartmentId;
      readonly departmentName: string;
    }
  | {
      readonly scope: 'company';
      readonly companyId: CompanyId;
    };

export interface KnowledgeScopeAuthority {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  readonly selectedDepartmentId?: DepartmentId;
  readonly authorizedDepartments: readonly {
    readonly id: DepartmentId;
    readonly name: string;
  }[];
}

export type KnowledgeScopeResolution =
  | { readonly ok: true; readonly value: ResolvedKnowledgeScope }
  | {
      readonly ok: false;
      readonly reason: 'department_not_selected' | 'department_not_authorized';
      readonly message: string;
    };

export function resolveKnowledgeScope(
  request: KnowledgeScopeRequest,
  authority: KnowledgeScopeAuthority,
): KnowledgeScopeResolution {
  if (request.scope === 'personal') {
    return {
      ok: true,
      value: {
        scope: 'personal',
        companyId: authority.companyId,
        userId: authority.userId,
      },
    };
  }

  if (request.scope === 'company') {
    return {
      ok: true,
      value: {
        scope: 'company',
        companyId: authority.companyId,
      },
    };
  }

  const departmentId = request.departmentId ?? authority.selectedDepartmentId;
  if (!departmentId) {
    return {
      ok: false,
      reason: 'department_not_selected',
      message: 'Select an authorized department before targeting department knowledge.',
    };
  }

  const department = authority.authorizedDepartments.find(candidate => candidate.id === departmentId);
  if (!department) {
    return {
      ok: false,
      reason: 'department_not_authorized',
      message: 'The requested department is not available in the authenticated scope.',
    };
  }

  return {
    ok: true,
    value: {
      scope: 'department',
      companyId: authority.companyId,
      departmentId: department.id,
      departmentName: department.name,
    },
  };
}
