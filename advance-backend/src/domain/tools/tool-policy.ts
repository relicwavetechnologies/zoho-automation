import { CANONICAL_TOOL_IDS, TOOL_SUPPORTED_ACTIONS, type CanonicalToolId } from './tool-id';

/**
 * Backend-owned classification for the desktop catalogue and permission writes.
 * A registered tool which is not classified here is intentionally not exposed.
 */
export type DesktopToolPolicy =
  | { readonly kind: 'configurable'; readonly supportedActions: readonly string[] }
  | { readonly kind: 'local'; readonly reason: string }
  | { readonly kind: 'system'; readonly supportedActions: readonly ['read']; readonly reason: string };

export function getDesktopToolPolicy(toolId: string): DesktopToolPolicy | null {
  if (toolId === 'runCommand') {
    return { kind: 'local', reason: 'Runs on this terminal and is approved locally for each command.' };
  }
  if (toolId === 'memoryRecall') {
    return { kind: 'system', supportedActions: ['read'], reason: 'System memory recall is available to authenticated members.' };
  }
  // omsSiteData was classified 'system' here, which made every write path
  // reject it outright — a company admin could not grant it to a department
  // even for themselves. It is configurable now: company admins hold it
  // regardless, and anyone else needs an explicit department grant.
  if (!CANONICAL_TOOL_IDS.includes(toolId as CanonicalToolId)) return null;
  return {
    kind: 'configurable',
    supportedActions: TOOL_SUPPORTED_ACTIONS[toolId as CanonicalToolId],
  };
}

export function isConfigurableDesktopTool(toolId: string): boolean {
  return getDesktopToolPolicy(toolId)?.kind === 'configurable';
}

/** Fixed Local/System tools have no persistent company or department policy rows. */
export function isFixedToolPolicy(toolId: string): boolean {
  const policy = getDesktopToolPolicy(toolId);
  return policy?.kind === 'local' || policy?.kind === 'system';
}

/**
 * Tools a department must be granted explicitly, never by inheriting a
 * company-role default.
 *
 * Their company-role default is permissive on purpose — it is the ceiling the
 * department overlay is clamped against, and a restrictive ceiling would make
 * them impossible to grant at all. Everywhere that same default would act as a
 * grant rather than a ceiling has to skip them: the department-less permission
 * path, and the MEMBER template that seeds new role matrices.
 */
export const DEPARTMENT_GRANT_ONLY_TOOLS: readonly CanonicalToolId[] = ['omsSiteData'];

export function isDepartmentGrantOnlyTool(toolId: string): boolean {
  return DEPARTMENT_GRANT_ONLY_TOOLS.includes(toolId as CanonicalToolId);
}
