import type { ToolActionGroup } from './tool-action-group';

export type PermissionSource =
  | 'company_default'       // tool registry default for the company role
  | 'company_override'      // explicit ToolActionPermission row
  | 'department_role'       // DepartmentToolPermission row for dept role
  | 'department_user_override' // DepartmentUserToolOverride row for specific user
  | 'derived';              // helper capability derived from another explicit grant

export interface PermissionDecision {
  readonly toolId: string;
  readonly actionGroup: ToolActionGroup;
  readonly allowed: boolean;
  readonly source: PermissionSource;
}
