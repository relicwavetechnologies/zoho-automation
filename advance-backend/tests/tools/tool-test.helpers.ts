/**
 * Shared test helpers for tool family unit tests.
 *
 * makeAllowedPerm  — PermissionResult with specific tool+actions allowed
 * makeDeniedPerm   — PermissionResult with nothing allowed
 * makeCtx          — minimal ToolExecutionContext (fake logger + clock + runContext)
 */

import type { PermissionResult } from '../../src/application/permissions/permission.types.ts';
import type { ToolExecutionContext } from '../../src/application/orchestration/tools/tool.contract.ts';
import type { ToolActionGroup } from '../../src/domain/permissions/tool-action-group.ts';
import type { Logger } from '../../src/shared/logger.ts';
import { asToolId, asCompanyId, asUserId } from '../../src/shared/ids.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';

export const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

export function makeAllowedPerm(toolId: string, actions: ToolActionGroup[]): PermissionResult {
  const tid = asToolId(toolId);
  return {
    allowedToolIds:       new Set([tid]) as any,
    allowedActionsByTool: new Map([[tid, new Set(actions) as any]]) as any,
    decisions:            [],
  };
}

export function makeDeniedPerm(): PermissionResult {
  return {
    allowedToolIds:       new Set() as any,
    allowedActionsByTool: new Map() as any,
    decisions:            [],
  };
}

export function makeCtx(toolId?: string, actions?: ToolActionGroup[]): ToolExecutionContext {
  return {
    runContext: {
      companyId:   asCompanyId('co-test'),
      userId:      asUserId('user-test'),
      companyRole: asCompanyRoleSlug('MEMBER'),
      channel:     'lark' as const,
    },
    perm:          toolId && actions ? makeAllowedPerm(toolId, actions) : makeDeniedPerm(),
    correlationId: 'test-corr',
    logger:        noopLogger,
    clock:         { now: () => new Date('2025-01-01'), nowMs: () => 1735689600000 },
  };
}
