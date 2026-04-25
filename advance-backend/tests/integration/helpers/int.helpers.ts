/**
 * Shared helpers for integration tests.
 *
 * Integration tests use real API clients instantiated from environment variables.
 * Each test suite skips automatically when the required env vars are absent.
 *
 * Required env vars per suite:
 *   Lark    — LARK_APP_ID, LARK_APP_SECRET
 *   Google  — GOOGLE_ACCESS_TOKEN
 *   Zoho    — ZOHO_ACCESS_TOKEN, ZOHO_ORG_ID
 */

import type { PermissionResult }     from '../../../src/application/permissions/permission.types.ts';
import type { ToolExecutionContext }  from '../../../src/application/orchestration/tools/tool.contract.ts';
import type { ToolActionGroup }       from '../../../src/domain/permissions/tool-action-group.ts';
import type { Logger }                from '../../../src/shared/logger.ts';
import { asToolId, asCompanyId, asUserId } from '../../../src/shared/ids.ts';
import { asCompanyRoleSlug }          from '../../../src/domain/permissions/company-role.ts';

// ─── Noop logger ──────────────────────────────────────────────────────────────

export const noopLogger: Logger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

// ─── Noop people resolver (used by larkTask to skip name→id resolution) ────────

export const noopPeopleResolver = {
  resolve: async (_companyId: string, _queries: string[], _requesterOpenId: string) => ({
    resolved:  [] as Array<{ openId: string; displayName: string }>,
    ambiguous: [] as Array<{ query: string; matches: Array<{ openId: string; displayName: string }> }>,
    notFound:  [] as string[],
  }),
};

// ─── PermissionResult helpers ─────────────────────────────────────────────────

export function makeAllowedPerm(toolId: string, actions: ToolActionGroup[]): PermissionResult {
  const tid = asToolId(toolId);
  return {
    allowedToolIds:       new Set([tid]) as PermissionResult['allowedToolIds'],
    allowedActionsByTool: new Map([[tid, new Set(actions) as PermissionResult['allowedActionsByTool'] extends Map<infer _K, infer V> ? V : never]]),
    decisions:            [],
  };
}

export function makeAllPermCtx(toolId: string): PermissionResult {
  return makeAllowedPerm(toolId, ['read', 'create', 'update', 'delete', 'send']);
}

// ─── ToolExecutionContext builder ─────────────────────────────────────────────

export function makeIntCtx(
  toolId:   string,
  overrides?: {
    companyId?:      string;
    userId?:         string;
    userExternalId?: string;
  },
): ToolExecutionContext {
  const companyId = overrides?.companyId ?? 'int-test-company';
  const userId    = overrides?.userId    ?? 'int-test-user';

  return {
    runContext: {
      companyId:      asCompanyId(companyId),
      userId:         asUserId(userId),
      companyRole:    asCompanyRoleSlug('MEMBER'),
      channel:        'lark' as const,
      ...(overrides?.userExternalId ? { userExternalId: overrides.userExternalId } : {}),
    },
    perm:          makeAllPermCtx(toolId),
    correlationId: `int-test-${toolId}`,
    logger:        noopLogger,
    clock:         { now: () => new Date(), nowMs: () => Date.now() },
  };
}

// ─── ISO datetime helpers ─────────────────────────────────────────────────────

/** Returns an ISO datetime that is `offsetMinutes` from now (UTC). */
export function futureISO(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}
