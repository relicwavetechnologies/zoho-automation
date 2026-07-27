import { createHash } from 'node:crypto';
import type { ToolId } from '../../shared/ids';

export const TOOL_FAMILY_IDS = [
  'lark',
  'google',
  'canva',
  'airtable',
  'aitable',
  'zoho',
  'context',
  'skills',
  'memory',
  'rag',
  'data',
  'execution',
  'scheduling',
  'semrush',
  'oms',
] as const;

export type ToolFamily = typeof TOOL_FAMILY_IDS[number];

export const TOOL_FAMILY_DEFINITIONS: Record<ToolFamily, {
  readonly displayName: string;
}> = {
  lark:       { displayName: 'Lark' },
  google:     { displayName: 'Google Workspace' },
  canva:      { displayName: 'Canva' },
  airtable:   { displayName: 'Airtable' },
  aitable:    { displayName: 'AITable' },
  zoho:       { displayName: 'Zoho' },
  context:    { displayName: 'Search and context' },
  skills:     { displayName: 'Skills' },
  memory:     { displayName: 'Memory' },
  rag:        { displayName: 'Document retrieval' },
  data:       { displayName: 'Data processing' },
  execution:  { displayName: 'Local execution' },
  scheduling: { displayName: 'Scheduled work' },
  semrush:    { displayName: 'Semrush' },
  oms:        { displayName: 'OMS' },
};

export function isToolFamily(value: string): value is ToolFamily {
  return Object.prototype.hasOwnProperty.call(TOOL_FAMILY_DEFINITIONS, value);
}

export type BuiltInRoleDefaults = {
  readonly MEMBER: boolean;
  readonly COMPANY_ADMIN: boolean;
  readonly SUPER_ADMIN: boolean;
};

const ALL_ROLES: BuiltInRoleDefaults = {
  MEMBER: true,
  COMPANY_ADMIN: true,
  SUPER_ADMIN: true,
};

const ADMIN_ONLY: BuiltInRoleDefaults = {
  MEMBER: false,
  COMPANY_ADMIN: true,
  SUPER_ADMIN: true,
};

function defineCapability<const Family extends ToolFamily, const Actions extends readonly string[]>(
  family: Family,
  supportedActions: Actions,
  defaultPermissions: BuiltInRoleDefaults = ALL_ROLES,
) {
  return { family, supportedActions, defaultPermissions } as const;
}

/**
 * Canonical governed capability taxonomy.
 *
 * Family, supported actions, and built-in role ceilings are defined together
 * so a new tool cannot be added to one policy map and silently omitted from
 * another. Runtime implementations and PermissionService remain authoritative
 * for execution; this object does not register or grant a tool.
 *
 * `runCommand` is intentionally absent. It runs on the user's own machine and
 * is gated per command, so it is exempt from company/department RBAC.
 */
export const TOOL_CAPABILITY_DEFINITIONS = {
  larkMessaging:  defineCapability('lark', ['read', 'send']),
  larkContacts:   defineCapability('lark', ['read']),
  larkTask:       defineCapability('lark', ['read', 'create', 'update', 'delete']),
  larkCalendar:   defineCapability('lark', ['read', 'create', 'update', 'delete']),
  larkMeeting:    defineCapability('lark', ['read']),
  larkDoc:        defineCapability('lark', ['read', 'create', 'update']),
  larkBase:       defineCapability('lark', ['read', 'create', 'update', 'delete'], ADMIN_ONLY),
  larkApproval:   defineCapability('lark', ['read', 'create'], ADMIN_ONLY),

  googleGmail:      defineCapability('google', ['read', 'create', 'update', 'delete', 'send']),
  googleDrive:      defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleCalendar:   defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleDocs:       defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleSheets:     defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleSlides:     defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleForms:      defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleTasks:      defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleContacts:   defineCapability('google', ['read', 'create', 'update', 'delete']),
  googleChat:       defineCapability('google', ['read', 'send', 'update']),
  googleAppsScript: defineCapability('google', ['read', 'create', 'update', 'delete', 'execute'], ADMIN_ONLY),

  canvaDesign: defineCapability('canva', ['read', 'create', 'update']),

  // Records are ordinary day-to-day work. Schema and automation edit the shape
  // of a base, so they remain off for members until an administrator grants them.
  airtableBase:       defineCapability('airtable', ['read']),
  airtableRecords:    defineCapability('airtable', ['read', 'create', 'update', 'delete']),
  airtableSchema:     defineCapability('airtable', ['read', 'create', 'update', 'delete'], ADMIN_ONLY),
  airtableAutomation: defineCapability('airtable', ['read', 'create', 'update', 'delete'], ADMIN_ONLY),

  // AITable is a distinct product. Its vocabulary keeps these IDs visibly
  // separate from Airtable in the catalogue.
  aitableDatasheets: defineCapability('aitable', ['read', 'create', 'update', 'delete']),
  // Fusion API can create and delete a field but has no update endpoint.
  aitableFields:     defineCapability('aitable', ['read', 'create', 'delete']),

  zohoCrm:   defineCapability('zoho', ['read', 'create', 'update', 'delete']),
  zohoBooks: defineCapability('zoho', ['read', 'create', 'update', 'delete']),

  contextSearch:   defineCapability('context', ['read']),
  webSearch:       defineCapability('context', ['read']),
  skillPublishing: defineCapability('skills', ['read', 'create', 'update', 'delete'], ADMIN_ONLY),
  memoryPublishing: defineCapability('memory', ['read', 'create']),
  memoryRecall:     defineCapability('memory', ['read']),
  documentRag:      defineCapability('rag', ['read']),
  dataProcessor:    defineCapability('data', ['read']),
  scheduledWorkflows: defineCapability('scheduling', ['read', 'create', 'update', 'delete', 'execute']),

  // These permissive MEMBER values are ceilings, not grants. Department-only
  // policy keeps both tools unavailable until explicitly granted.
  semrush:     defineCapability('semrush', ['read']),
  omsSiteData: defineCapability('oms', ['read']),
} as const;

export type CanonicalToolId = keyof typeof TOOL_CAPABILITY_DEFINITIONS;

/** All canonical governed tool IDs, in stable catalogue order. */
export const CANONICAL_TOOL_IDS = Object.freeze(
  Object.keys(TOOL_CAPABILITY_DEFINITIONS) as CanonicalToolId[],
);

function mapCapabilities<Value>(
  select: (definition: typeof TOOL_CAPABILITY_DEFINITIONS[CanonicalToolId]) => Value,
): Record<CanonicalToolId, Value> {
  return Object.fromEntries(
    CANONICAL_TOOL_IDS.map(toolId => [toolId, select(TOOL_CAPABILITY_DEFINITIONS[toolId])]),
  ) as Record<CanonicalToolId, Value>;
}

export const TOOL_FAMILY_MAP: Readonly<Record<CanonicalToolId, ToolFamily>> =
  mapCapabilities<ToolFamily>(definition => definition.family);
export const TOOL_SUPPORTED_ACTIONS: Readonly<Record<CanonicalToolId, readonly string[]>> =
  mapCapabilities<readonly string[]>(definition => definition.supportedActions);
export const TOOL_DEFAULT_PERMISSIONS: Readonly<Record<CanonicalToolId, BuiltInRoleDefaults>> =
  mapCapabilities<BuiltInRoleDefaults>(definition => definition.defaultPermissions);

/** Every canonical tool ID in one family, in stable catalogue order. */
export function toolIdsForFamily(family: ToolFamily): CanonicalToolId[] {
  return CANONICAL_TOOL_IDS.filter(toolId => TOOL_CAPABILITY_DEFINITIONS[toolId].family === family);
}

/**
 * Content-addressed revision for every permission snapshot derived from the
 * canonical tool policy. Changing a tool ID, supported action, or role default
 * automatically moves readers to a fresh cache namespace after deployment.
 */
export const TOOL_PERMISSION_POLICY_REVISION = createHash('sha256')
  .update(JSON.stringify({
    toolIds: CANONICAL_TOOL_IDS,
    supportedActions: TOOL_SUPPORTED_ACTIONS,
    defaults: TOOL_DEFAULT_PERMISSIONS,
  }))
  .digest('hex')
  .slice(0, 16);

export const asToolId = (s: CanonicalToolId): ToolId => s as unknown as ToolId;
