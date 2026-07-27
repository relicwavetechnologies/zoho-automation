import { createHash } from 'node:crypto';
import type { ToolId } from '../../shared/ids';

/** All canonical tool IDs in the system. Add new tools here. */
export const CANONICAL_TOOL_IDS = [
  'larkMessaging',
  'larkContacts',
  'larkTask',
  'larkCalendar',
  'larkMeeting',
  'larkDoc',
  'larkBase',
  'larkApproval',
  'googleGmail',
  'googleDrive',
  'googleCalendar',
  'googleDocs',
  'googleSheets',
  'googleSlides',
  'googleForms',
  'googleTasks',
  'googleContacts',
  'googleChat',
  'googleAppsScript',
  'canvaDesign',
  'airtableRecords',
  'airtableSchema',
  'airtableAutomation',
  // AITable (aitable.ai) is a different product from Airtable, not a variant of
  // it. The IDs deliberately borrow AITable's own vocabulary — spaces, nodes,
  // datasheets, fields — rather than Airtable's bases and tables, so the two
  // families do not read as near-duplicates in the catalogue or to the model.
  'aitableDatasheets',
  'aitableFields',
  'zohoCrm',
  'zohoBooks',
  'contextSearch',
  'webSearch',
  'skillPublishing',
  'memoryPublishing',
  'memoryRecall',
  'documentRag',
  'dataProcessor',
  'scheduledWorkflows',
  'semrush',
  'omsSiteData',
  // NOTE: 'runCommand' is intentionally NOT here. The terminal tool runs on the
  // user's own machine and is gated per-command by the user, so it is exempt
  // from company/department RBAC. It lives in the tool registry + RegisteredTool
  // catalog only. See run-command.tool.ts permissionCheck().
] as const;

export type CanonicalToolId = typeof CANONICAL_TOOL_IDS[number];

export type ToolFamily = 'lark' | 'google' | 'canva' | 'airtable' | 'aitable' | 'zoho' | 'context' | 'skills' | 'memory' | 'rag' | 'data' | 'execution' | 'scheduling' | 'semrush' | 'oms';

export const TOOL_FAMILY_MAP: Record<CanonicalToolId, ToolFamily> = {
  larkMessaging:  'lark',
  larkContacts:   'lark',
  larkTask:       'lark',
  larkCalendar:   'lark',
  larkMeeting:    'lark',
  larkDoc:        'lark',
  larkBase:       'lark',
  larkApproval:   'lark',
  googleGmail:    'google',
  googleDrive:    'google',
  googleCalendar: 'google',
  googleDocs:     'google',
  googleSheets:   'google',
  googleSlides:   'google',
  googleForms:    'google',
  googleTasks:    'google',
  googleContacts: 'google',
  googleChat:     'google',
  googleAppsScript: 'google',
  canvaDesign:    'canva',
  airtableRecords:    'airtable',
  airtableSchema:     'airtable',
  airtableAutomation: 'airtable',
  aitableDatasheets:  'aitable',
  aitableFields:      'aitable',
  zohoCrm:        'zoho',
  zohoBooks:      'zoho',
  contextSearch:  'context',
  webSearch:      'context',
  skillPublishing: 'skills',
  memoryPublishing: 'memory',
  memoryRecall: 'memory',
  documentRag:    'rag',
  dataProcessor:  'data',
  scheduledWorkflows: 'scheduling',
  semrush: 'semrush',
  omsSiteData: 'oms',
};

/**
 * Every tool ID in one family, derived rather than listed so a new tool cannot
 * be added to a family and then quietly missed by callers that switch on it.
 */
export function toolIdsForFamily(family: ToolFamily): CanonicalToolId[] {
  return CANONICAL_TOOL_IDS.filter(toolId => TOOL_FAMILY_MAP[toolId] === family);
}

/** Action groups each tool supports. Drives permission defaults. */
export const TOOL_SUPPORTED_ACTIONS: Record<CanonicalToolId, readonly string[]> = {
  larkMessaging:  ['read', 'send'],
  larkContacts:   ['read'],
  larkTask:       ['read', 'create', 'update', 'delete'],
  larkCalendar:   ['read', 'create', 'update', 'delete'],
  larkMeeting:    ['read'],
  larkDoc:        ['read', 'create', 'update'],
  larkBase:       ['read', 'create', 'update', 'delete'],
  larkApproval:   ['read', 'create'],
  googleGmail:    ['read', 'create', 'update', 'delete', 'send'],
  googleDrive:    ['read', 'create', 'update', 'delete'],
  googleCalendar: ['read', 'create', 'update', 'delete'],
  googleDocs:     ['read', 'create', 'update', 'delete'],
  googleSheets:   ['read', 'create', 'update', 'delete'],
  googleSlides:   ['read', 'create', 'update', 'delete'],
  googleForms:    ['read', 'create', 'update', 'delete'],
  googleTasks:    ['read', 'create', 'update', 'delete'],
  googleContacts: ['read', 'create', 'update', 'delete'],
  googleChat:     ['read', 'send', 'update'],
  googleAppsScript: ['read', 'create', 'update', 'delete', 'execute'],
  canvaDesign:    ['read', 'create', 'update'],
  airtableRecords:    ['read', 'create', 'update', 'delete'],
  airtableSchema:     ['read', 'create', 'update', 'delete'],
  airtableAutomation: ['read', 'create', 'update', 'delete'],
  aitableDatasheets:  ['read', 'create', 'update', 'delete'],
  // AITable's Fusion API can create and delete a field but has no endpoint to
  // alter one, so 'update' is absent rather than declared and unimplementable.
  aitableFields:      ['read', 'create', 'delete'],
  zohoCrm:        ['read', 'create', 'update', 'delete'],
  zohoBooks:      ['read', 'create', 'update', 'delete'],
  contextSearch:  ['read'],
  webSearch:      ['read'],
  skillPublishing: ['read', 'create', 'update', 'delete'],
  memoryPublishing: ['read', 'create'],
  memoryRecall: ['read'],
  documentRag:    ['read'],
  dataProcessor:  ['read'],
  scheduledWorkflows: ['read', 'create', 'update', 'delete', 'execute'],
  semrush: ['read'],
  omsSiteData: ['read'],
};

/** Default permission per tool per built-in company role. */
export const TOOL_DEFAULT_PERMISSIONS: Record<CanonicalToolId, { MEMBER: boolean; COMPANY_ADMIN: boolean; SUPER_ADMIN: boolean }> = {
  larkMessaging:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkContacts:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkTask:       { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkCalendar:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkMeeting:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkDoc:        { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkBase:       { MEMBER: false, COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkApproval:   { MEMBER: false, COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleGmail:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleDrive:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleCalendar: { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleDocs:     { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleSheets:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleSlides:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleForms:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleTasks:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleContacts: { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleChat:     { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleAppsScript: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  canvaDesign:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  // Records are ordinary day-to-day work. Schema and automation edit the shape
  // of a base — including delete_table / delete_automation — so they follow the
  // larkBase precedent and stay off for members until an admin grants them.
  airtableRecords:    { MEMBER: true,  COMPANY_ADMIN: true, SUPER_ADMIN: true },
  airtableSchema:     { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  airtableAutomation: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  // A ceiling, not a grant. AITable is department-grant-only in tool-policy, so
  // this permissive MEMBER default is only what makes granting it to a
  // department possible at all; the grant-only list is what keeps it away from
  // everyone who has no department selected, and the company-admin floor in
  // permission.service is what hands it to administrators. Setting MEMBER false
  // here would instead make the tool permanently ungrantable.
  aitableDatasheets:  { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  aitableFields:      { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  zohoCrm:        { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  zohoBooks:      { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  contextSearch:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  webSearch:      { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  skillPublishing: { MEMBER: false, COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  memoryPublishing: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  memoryRecall: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  documentRag:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  dataProcessor:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  scheduledWorkflows: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  // A ceiling, not a grant. Semrush is a metered company subscription, so it is
  // department-grant-only in tool-policy: this permissive default is what lets
  // an admin grant it to a department at all, and the grant-only list is what
  // stops it reaching everyone who has no department selected.
  semrush: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  // OMS inventory access is deliberately fixed to live company administrators.
  // PermissionService strips normal role overrides before applying that rule.
  // A ceiling, not a grant. OMS stays department-grant-only in
  // permission.service, so raising this lets an admin grant it to a role
  // without handing it to every member who has no department selected.
  omsSiteData: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
};

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
