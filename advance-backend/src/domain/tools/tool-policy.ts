import { CANONICAL_TOOL_IDS, TOOL_SUPPORTED_ACTIONS, type CanonicalToolId } from './tool-id';

/**
 * Backend-owned classification for the desktop catalogue and permission writes.
 * A registered tool which is not classified here is intentionally not exposed.
 */
export type DesktopToolPolicy =
  | { readonly kind: 'configurable'; readonly supportedActions: readonly string[] }
  | { readonly kind: 'inherited'; readonly supportedActions: readonly string[]; readonly reason: string }
  | { readonly kind: 'local'; readonly reason: string }
  | { readonly kind: 'system'; readonly supportedActions: readonly ['read']; readonly reason: string };

export function getDesktopToolPolicy(toolId: string): DesktopToolPolicy | null {
  if (toolId === 'runCommand') {
    return { kind: 'local', reason: 'Runs on this terminal and is approved locally for each command.' };
  }
  if (toolId === 'menhoodData') {
    return { kind: 'inherited', supportedActions: ['read'], reason: 'Access follows Airtable Records.' };
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


/** Inherited, Local, and System tools have no persistent company or department policy rows. */
export function isFixedToolPolicy(toolId: string): boolean {
  const policy = getDesktopToolPolicy(toolId);
  return policy?.kind === 'inherited' || policy?.kind === 'local' || policy?.kind === 'system';
}

/**
 * Tools a department or admin must grant explicitly, never by inheriting a
 * permissive MEMBER company-role default.
 *
 * Their company-role default is permissive on purpose — it is the ceiling the
 * department overlay is clamped against, and a restrictive ceiling would make
 * them impossible to grant at all. Everywhere that same default would act as a
 * grant rather than a ceiling has to skip them: the department-less permission
 * path, and the MEMBER template that seeds new role matrices. This keeps a new
 * normal member's no-department surface to Lark, Google Workspace, Web Search,
 * Knowledge, Data Export, and Mail Ops.
 */
export const DEPARTMENT_GRANT_ONLY_TOOLS: readonly CanonicalToolId[] = [
  'omsSiteData',
  'semrush',
  'zohoCrm',
  'zohoBooks',
  'canvaDesign',
  'airtableBase',
  'airtableRecords',
  // AITable ships to company administrators first. Keeping it here means the
  // permissive company-role ceiling in tool-id never reaches a member who has
  // no department selected, so opening it to a department later stays a
  // deliberate grant rather than something that already happened by default.
  'aitableDatasheets',
  'aitableFields',
  'shopifyAnalytics',
  'shopifyOrders',
  'shopifyCustomers',
  'scheduledWorkflows',
];

/**
 * Capabilities whose company RBAC decision carries into any active department
 * unless that department role or member has an explicit override. Knowledge
 * scope and human-approval policy are enforced again by the knowledge core.
 */
export const DEPARTMENT_COMPANY_INHERITED_TOOLS: readonly CanonicalToolId[] = [
  'connectApp',
  'knowledge',
  // Publishing is ownership-scoped by [companyId, userId, artifactId], so the
  // company-level capability can flow into a department without exposing
  // another member's documents.
  'artifactPublish',
];

export function isDepartmentGrantOnlyTool(toolId: string): boolean {
  return DEPARTMENT_GRANT_ONLY_TOOLS.includes(toolId as CanonicalToolId);
}
