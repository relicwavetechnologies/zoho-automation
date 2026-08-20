import { createHash } from 'node:crypto';
import type { ToolId } from '../../shared/ids';
import type { ConnectionProvider } from '../connections/connection-provider';

export const TOOL_FAMILY_IDS = [
  'lark',
  'google',
  'canva',
  'airtable',
  'aitable',
  'zoho',
  'shopify',
  'context',
  'skills',
  'memory',
  'rag',
  'data',
  'execution',
  'scheduling',
  'semrush',
  'oms',
  'menhood',
] as const;

export type ToolFamily = typeof TOOL_FAMILY_IDS[number];

export type CapabilityConnectionProvider = ConnectionProvider;

export type ToolFamilyDefinition = {
  readonly displayName: string;
  readonly connectionMode: 'member_selectable' | 'backend_managed' | 'none';
  readonly connectionProvider?: CapabilityConnectionProvider;
  readonly skillMode: 'none' | 'optional' | 'required';
  readonly routingAliases: readonly string[];
};

export const TOOL_FAMILY_DEFINITIONS: Record<ToolFamily, ToolFamilyDefinition> = {
  lark:       { displayName: 'Lark', connectionMode: 'member_selectable', connectionProvider: 'lark', skillMode: 'optional', routingAliases: ['lark', 'feishu'] },
  google:     { displayName: 'Google Workspace', connectionMode: 'member_selectable', connectionProvider: 'google_workspace', skillMode: 'optional', routingAliases: ['google', 'google workspace', 'gmail'] },
  canva:      { displayName: 'Canva', connectionMode: 'member_selectable', connectionProvider: 'canva', skillMode: 'optional', routingAliases: ['canva'] },
  airtable:   { displayName: 'Airtable', connectionMode: 'member_selectable', connectionProvider: 'airtable', skillMode: 'optional', routingAliases: ['airtable'] },
  aitable:    { displayName: 'AITable', connectionMode: 'member_selectable', connectionProvider: 'aitable', skillMode: 'optional', routingAliases: ['aitable'] },
  zoho:       { displayName: 'Zoho', connectionMode: 'member_selectable', connectionProvider: 'zoho', skillMode: 'optional', routingAliases: ['zoho'] },
  shopify:    { displayName: 'Shopify', connectionMode: 'member_selectable', connectionProvider: 'shopify', skillMode: 'optional', routingAliases: ['shopify', 'shopifyql', 'store sales', 'store orders', 'store customers'] },
  context:    { displayName: 'Search and context', connectionMode: 'none', skillMode: 'none', routingAliases: [] },
  skills:     { displayName: 'Skills', connectionMode: 'none', skillMode: 'optional', routingAliases: [] },
  memory:     { displayName: 'Memory', connectionMode: 'none', skillMode: 'optional', routingAliases: [] },
  rag:        { displayName: 'Document retrieval', connectionMode: 'none', skillMode: 'optional', routingAliases: [] },
  data:       {
    displayName: 'Data processing',
    connectionMode: 'none',
    skillMode: 'optional',
    routingAliases: ['export data', 'full export', 'complete csv', 'google sheet', 'large dataset'],
  },
  execution:  { displayName: 'Local execution', connectionMode: 'none', skillMode: 'optional', routingAliases: [] },
  scheduling: { displayName: 'Scheduled work', connectionMode: 'none', skillMode: 'required', routingAliases: [] },
  semrush:    { displayName: 'Semrush', connectionMode: 'backend_managed', skillMode: 'optional', routingAliases: ['semrush'] },
  oms:        { displayName: 'OMS', connectionMode: 'backend_managed', skillMode: 'optional', routingAliases: ['oms'] },
  menhood:    { displayName: 'Menhood', connectionMode: 'backend_managed', skillMode: 'optional', routingAliases: ['menhood'] },
};

export function isToolFamily(value: string): value is ToolFamily {
  return Object.prototype.hasOwnProperty.call(TOOL_FAMILY_DEFINITIONS, value);
}

export function toolFamiliesForQuery(query: string): ToolFamily[] {
  const normalized = normalizeRoutingText(query);
  return TOOL_FAMILY_IDS.filter(family =>
    TOOL_FAMILY_DEFINITIONS[family].routingAliases.some(alias =>
      includesRoutingPhrase(normalized, normalizeRoutingText(alias)),
    ),
  );
}

function normalizeRoutingText(value: string): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
}

function includesRoutingPhrase(text: string, phrase: string): boolean {
  return Boolean(phrase) && ` ${text} `.includes(` ${phrase} `);
}

export function isCanonicalToolId(value: string): value is CanonicalToolId {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY_DEFINITIONS, value);
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

const DENY_ALL: BuiltInRoleDefaults = {
  MEMBER: false,
  COMPANY_ADMIN: false,
  SUPER_ADMIN: false,
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

  // Shopify starts read-only and split by sensitivity. Keeping analytics,
  // orders, and customers separate lets RBAC grant aggregate reporting without
  // implicitly granting order-level or protected-customer access.
  shopifyAnalytics: defineCapability('shopify', ['read']),
  shopifyOrders:    defineCapability('shopify', ['read']),
  shopifyCustomers: defineCapability('shopify', ['read']),

  artifactPublish: defineCapability('context', ['create']),
  webSearch:       defineCapability('context', ['read']),
  connectApp:      defineCapability('context', ['create']),
  knowledge:       defineCapability('memory', ['read', 'create', 'update', 'delete']),
  mailAutomations:  defineCapability('scheduling', ['read', 'create', 'update', 'delete', 'execute']),
  scheduledWorkflows: defineCapability('scheduling', ['read', 'create', 'update', 'delete', 'execute']),

  // These permissive MEMBER values are ceilings, not grants. Department-only
  // policy keeps both tools unavailable until explicitly granted.
  semrush:     defineCapability('semrush', ['read']),
  omsSiteData: defineCapability('oms', ['read']),
  menhoodData: defineCapability('menhood', ['read'], DENY_ALL),
} as const;

export type CanonicalToolId = keyof typeof TOOL_CAPABILITY_DEFINITIONS;

/** All canonical governed tool IDs, in stable catalogue order. */
export const CANONICAL_TOOL_IDS = Object.freeze(
  Object.keys(TOOL_CAPABILITY_DEFINITIONS) as CanonicalToolId[],
);

/**
 * The name a canonical tool is registered under inside the container.
 *
 * Mirrors `typedToolName` in divo-pi: every governed tool is its own typed Pi
 * tool, and the id is lowercased on the way in because a provider's tool names
 * may not carry case. The transform is lossy, which is why the reverse lookup
 * below is a table of the ids we actually have rather than an attempt to undo
 * it — an inverted guess would confidently name a tool that does not exist.
 */
export function typedToolNameFor(toolId: string): string {
  if (toolId === 'artifactPublish') return 'divo_publish';
  const snake = toolId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  return `divo_${snake}`;
}

const CANONICAL_TOOL_ID_BY_TYPED_NAME: ReadonlyMap<string, CanonicalToolId> = new Map(
  CANONICAL_TOOL_IDS.map(toolId => [typedToolNameFor(toolId), toolId] as const),
);

/**
 * Which governed capability a container tool call was, or nothing.
 *
 * The container reports the tool it ran — `divo_google_gmail` — and that is all
 * the identity a run has now that the single `divo_gateway` tool is gone. Left
 * unresolved, every governed call reached the reader as its own name spelled
 * out with spaces in it ("Google gmail") and lost its vendor mark, because the
 * table that knows the product name is keyed by canonical id and never saw one.
 *
 * A miss returns undefined rather than a derived guess: an unknown `divo_*`
 * tool is a tool this backend does not govern, and naming it anyway would put
 * a Gmail mark beside something that is not Gmail.
 */
export function canonicalToolIdForToolName(toolName: string): CanonicalToolId | undefined {
  return CANONICAL_TOOL_ID_BY_TYPED_NAME.get(toolName);
}

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

// Permission policy includes the department-inheritance table, which is a
// separate authority from the canonical tool definitions above. Bump this
// epoch when that table changes so a live cache cannot retain the old overlay.
const TOOL_PERMISSION_POLICY_EPOCH = 'connect-app-inherited-v1';

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
    policyEpoch: TOOL_PERMISSION_POLICY_EPOCH,
    toolIds: CANONICAL_TOOL_IDS,
    supportedActions: TOOL_SUPPORTED_ACTIONS,
    defaults: TOOL_DEFAULT_PERMISSIONS,
  }))
  .digest('hex')
  .slice(0, 16);

export const asToolId = (s: CanonicalToolId): ToolId => s as unknown as ToolId;
