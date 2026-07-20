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
  if (toolId === 'omsSiteData') {
    return { kind: 'system', supportedActions: ['read'], reason: 'OMS Site Data is a company-owned, read-only capability available only to active company administrators.' };
  }
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
