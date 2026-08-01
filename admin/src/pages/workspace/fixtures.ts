/**
 * Fixture data for the Workspace mock.
 *
 * Every shape here mirrors a real backend contract so the mock can become the
 * implementation rather than being thrown away. Where a field has no backend
 * behind it yet, `DATA_SOURCES` below says so explicitly — the UI renders that
 * honestly instead of implying the endpoint exists.
 */

/* ── Roles ────────────────────────────────────────────
   Three independent axes in the backend. Conflating them is how permission
   UIs go wrong, so they stay separate here too.
     company role  — the ceiling      (AdminMembership.role)
     department    — the grant        (DepartmentMembership → DepartmentRole.slug)
     scope         — a UI concept, derived from the two above
*/
export type CompanyRole = 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN'
export type DeptRoleSlug = 'MANAGER' | 'MEMBER' | string

export type Persona = 'member' | 'manager' | 'admin'
export type ScopeKind = 'you' | 'team' | 'company'

export type Scope = {
  id: string
  kind: ScopeKind
  label: string
  detail: string
  departmentId?: string
}

/** Mirrors `ToolActionGroup` — src/domain/permissions/tool-action-group.ts */
export type ActionGroup = 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'
export const ACTION_GROUPS: ActionGroup[] = ['read', 'create', 'update', 'delete', 'send', 'execute']

/** Mirrors `PermissionSource` — src/domain/permissions/permission-decision.ts */
export type PermissionSource =
  | 'company_default'
  | 'company_override'
  | 'department_role'
  | 'department_user_override'
  | 'derived'

export const SOURCE_LABEL: Record<PermissionSource, string> = {
  company_default: 'Company default',
  company_override: 'Company policy',
  department_role: 'Role grant',
  department_user_override: 'Personal override',
  derived: 'Automatic',
}

/** Mirrors `ConnectionProvider` — src/application/connections/connection-registry.port.ts */
export type Provider = 'google_workspace' | 'lark' | 'canva' | 'airtable' | 'aitable' | 'zoho'

/* ── Tools ───────────────────────────────────────────
   Ids and supported actions taken from TOOL_CAPABILITY_DEFINITIONS
   (src/domain/tools/tool-id.ts). `adminOnly` marks the six tools whose
   built-in MEMBER default is false. */
export type Tool = {
  id: string
  name: string
  family: string
  provider?: Provider
  actions: ActionGroup[]
  adminOnly?: boolean
  /** Plain-English, used to build the permission sentence. */
  verb: Partial<Record<ActionGroup, string>>
}

export const TOOLS: Tool[] = [
  {
    id: 'googleGmail', name: 'Gmail', family: 'Google', provider: 'google_workspace',
    actions: ['read', 'create', 'update', 'delete', 'send'],
    verb: { read: 'read mail', send: 'send mail', create: 'draft mail', delete: 'delete mail' },
  },
  {
    id: 'googleDrive', name: 'Drive', family: 'Google', provider: 'google_workspace',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read files', create: 'create files', update: 'edit files', delete: 'delete files' },
  },
  {
    id: 'googleCalendar', name: 'Calendar', family: 'Google', provider: 'google_workspace',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'see the calendar', create: 'book meetings', update: 'move meetings' },
  },
  {
    id: 'googleSheets', name: 'Sheets', family: 'Google', provider: 'google_workspace',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read spreadsheets', create: 'build spreadsheets', update: 'edit spreadsheets' },
  },
  {
    id: 'larkMessaging', name: 'Lark messages', family: 'Lark', provider: 'lark',
    actions: ['read', 'send'],
    verb: { read: 'read Lark chats', send: 'send Lark messages' },
  },
  {
    id: 'larkCalendar', name: 'Lark calendar', family: 'Lark', provider: 'lark',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'see the Lark calendar', create: 'book Lark meetings' },
  },
  {
    id: 'larkDoc', name: 'Lark docs', family: 'Lark', provider: 'lark',
    actions: ['read', 'create', 'update'],
    verb: { read: 'read docs', create: 'write docs', update: 'edit docs' },
  },
  {
    id: 'larkBase', name: 'Lark Base', family: 'Lark', provider: 'lark', adminOnly: true,
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read Base tables', update: 'edit Base records' },
  },
  {
    id: 'airtableRecords', name: 'Airtable records', family: 'Airtable', provider: 'airtable',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read records', create: 'add records', update: 'edit records', delete: 'delete records' },
  },
  {
    id: 'zohoBooks', name: 'Zoho Books', family: 'Zoho', provider: 'zoho',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read the books', create: 'raise invoices', update: 'edit invoices' },
  },
  {
    id: 'zohoCrm', name: 'Zoho CRM', family: 'Zoho', provider: 'zoho',
    actions: ['read', 'create', 'update', 'delete'],
    verb: { read: 'read the CRM', create: 'add leads', update: 'update deals' },
  },
  {
    id: 'canvaDesign', name: 'Canva', family: 'Canva', provider: 'canva',
    actions: ['read', 'create', 'update'],
    verb: { read: 'open designs', create: 'make designs' },
  },
  {
    id: 'webSearch', name: 'Web search', family: 'Research',
    actions: ['read'],
    verb: { read: 'search the web' },
  },
  {
    id: 'dataExport', name: 'Data export', family: 'Research',
    actions: ['create'],
    verb: { create: 'export data out of Divo' },
  },
  {
    id: 'memoryRecall', name: 'Memory', family: 'Divo',
    actions: ['read'],
    verb: { read: 'recall what it has learned' },
  },
  {
    id: 'skillPublishing', name: 'Publish skills', family: 'Divo', adminOnly: true,
    actions: ['read', 'create', 'update', 'delete'],
    verb: { create: 'publish skills to others' },
  },
]

export const toolById = (id: string) => TOOLS.find((t) => t.id === id)

/* ── Grants ──────────────────────────────────────────
   A resolved permission carries its provenance — this is the single most
   useful thing the backend gives us and the thing the old mock ignored. */
export type Grant = { allowed: boolean; source: PermissionSource }
export type GrantMap = Record<string, Partial<Record<ActionGroup, Grant>>>

const g = (source: PermissionSource, allowed = true): Grant => ({ allowed, source })

/** What the FINANCE department role "Member" grants. */
export const ROLE_GRANTS: Record<string, GrantMap> = {
  MEMBER: {
    googleGmail: { read: g('department_role'), create: g('department_role') },
    googleDrive: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    googleCalendar: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    googleSheets: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    larkMessaging: { read: g('department_role'), send: g('department_role') },
    larkCalendar: { read: g('department_role'), create: g('department_role') },
    larkDoc: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    zohoBooks: { read: g('department_role') },
    webSearch: { read: g('department_role') },
    memoryRecall: { read: g('company_default') },
    dataExport: { create: g('derived') },
  },
  ANALYST: {
    googleGmail: { read: g('department_role') },
    googleDrive: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    googleSheets: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    googleCalendar: { read: g('department_role') },
    larkMessaging: { read: g('department_role'), send: g('department_role') },
    larkDoc: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    zohoBooks: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    zohoCrm: { read: g('department_role') },
    airtableRecords: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    webSearch: { read: g('department_role') },
    memoryRecall: { read: g('company_default') },
    dataExport: { create: g('derived') },
  },
  MANAGER: {
    googleGmail: { read: g('department_role'), create: g('department_role'), send: g('department_role') },
    googleDrive: { read: g('department_role'), create: g('department_role'), update: g('department_role'), delete: g('department_role') },
    googleCalendar: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    googleSheets: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    larkMessaging: { read: g('department_role'), send: g('department_role') },
    larkCalendar: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    larkDoc: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    zohoBooks: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    zohoCrm: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    airtableRecords: { read: g('department_role'), create: g('department_role'), update: g('department_role') },
    webSearch: { read: g('department_role') },
    memoryRecall: { read: g('company_default') },
    dataExport: { create: g('derived') },
  },
}

/**
 * The company ceiling. A department grant is silently clamped by this in the
 * backend (`perm.dept.ceiling.blocked`) — the UI has to surface it at the
 * moment of the toggle, not let someone discover it later.
 */
export const COMPANY_CEILING: Record<string, ActionGroup[]> = {
  googleGmail: ['read', 'create', 'update', 'send'], // delete withheld company-wide
  googleDrive: ['read', 'create', 'update', 'delete'],
  googleCalendar: ['read', 'create', 'update', 'delete'],
  googleSheets: ['read', 'create', 'update', 'delete'],
  larkMessaging: ['read', 'send'],
  larkCalendar: ['read', 'create', 'update', 'delete'],
  larkDoc: ['read', 'create', 'update'],
  larkBase: [],
  airtableRecords: ['read', 'create', 'update'], // delete withheld
  zohoBooks: ['read', 'create', 'update'],
  zohoCrm: ['read', 'create', 'update'],
  canvaDesign: ['read', 'create', 'update'],
  webSearch: ['read'],
  dataExport: ['create'],
  memoryRecall: ['read'],
  skillPublishing: [],
}

export const ceilingAllows = (toolId: string, action: ActionGroup) =>
  (COMPANY_CEILING[toolId] ?? []).includes(action)

/* ── People ──────────────────────────────────────────── */
export type Person = {
  id: string
  name: string
  email: string
  initials: string
  companyRole: CompanyRole
  deptRole: DeptRoleSlug
  deptRoleName: string
  title: string
  joined: string
  lastActive: string
  runs30d: number
  spend30d: number
  /** Per-member overrides layered on top of the role grant. */
  overrides: GrantMap
  connections: string[]
}

export const PEOPLE: Person[] = [
  {
    id: 'u_ananya', name: 'Ananya Mehta', email: 'ananya@acme.co', initials: 'AM',
    companyRole: 'MEMBER', deptRole: 'MEMBER', deptRoleName: 'Member', title: 'Finance associate',
    joined: '12 Mar 2026', lastActive: '4 minutes ago', runs30d: 214, spend30d: 18.42,
    overrides: { googleGmail: { send: g('department_user_override') } },
    connections: ['google_workspace', 'lark'],
  },
  {
    id: 'u_rohan', name: 'Rohan Iyer', email: 'rohan@acme.co', initials: 'RI',
    companyRole: 'MEMBER', deptRole: 'ANALYST', deptRoleName: 'Analyst', title: 'Financial analyst',
    joined: '2 Jan 2026', lastActive: '1 hour ago', runs30d: 486, spend30d: 41.08,
    overrides: {}, connections: ['google_workspace', 'lark', 'airtable'],
  },
  {
    id: 'u_priya', name: 'Priya Nair', email: 'priya@acme.co', initials: 'PN',
    companyRole: 'MEMBER', deptRole: 'ANALYST', deptRoleName: 'Analyst', title: 'Financial analyst',
    joined: '18 Feb 2026', lastActive: 'Yesterday', runs30d: 132, spend30d: 11.90,
    overrides: { zohoBooks: { update: g('department_user_override', false) } },
    connections: ['google_workspace'],
  },
  {
    id: 'u_kabir', name: 'Kabir Shah', email: 'kabir@acme.co', initials: 'KS',
    companyRole: 'MEMBER', deptRole: 'MEMBER', deptRoleName: 'Member', title: 'Accounts payable',
    joined: '5 May 2026', lastActive: '3 days ago', runs30d: 38, spend30d: 3.15,
    overrides: {}, connections: ['lark'],
  },
  {
    id: 'u_meera', name: 'Meera Rao', email: 'meera@acme.co', initials: 'MR',
    companyRole: 'MEMBER', deptRole: 'MEMBER', deptRoleName: 'Member', title: 'Finance associate',
    joined: '21 Jun 2026', lastActive: 'Never', runs30d: 0, spend30d: 0,
    overrides: {}, connections: [],
  },
  {
    id: 'u_arjun', name: 'Arjun Shah', email: 'arjun@acme.co', initials: 'AS',
    companyRole: 'MEMBER', deptRole: 'MANAGER', deptRoleName: 'Manager', title: 'Finance lead',
    joined: '8 Nov 2025', lastActive: 'Just now', runs30d: 301, spend30d: 27.66,
    overrides: {}, connections: ['google_workspace', 'lark', 'zoho'],
  },
]

export const personById = (id: string) => PEOPLE.find((p) => p.id === id)

/** Resolve a person's effective permissions the way the backend does: role grant, then override. */
export function resolveGrants(person: Person): GrantMap {
  const base = ROLE_GRANTS[person.deptRole] ?? ROLE_GRANTS.MEMBER
  const out: GrantMap = {}
  for (const [toolId, actions] of Object.entries(base)) out[toolId] = { ...actions }
  for (const [toolId, actions] of Object.entries(person.overrides)) {
    out[toolId] = { ...(out[toolId] ?? {}), ...actions }
  }
  return out
}

/* ── Connections ─────────────────────────────────────── */
export type ConnStatus = 'connected' | 'needs_key' | 'not_connected' | 'admin_only'

export type ConnectionDef = {
  provider: Provider
  name: string
  blurb: string
  /** Can an ordinary member run this connect flow? Verified against route guards. */
  memberCanConnect: boolean
  auth: 'OAuth' | 'API key' | 'OAuth or token'
  /** Human-readable consent lines, grouped from the real scope lists. */
  consent: { title: string; detail: string }[]
  allOrNothing?: string
}

export const CONNECTORS: ConnectionDef[] = [
  {
    provider: 'google_workspace', name: 'Google Workspace', auth: 'OAuth', memberCanConnect: true,
    blurb: 'Mail, Drive, Calendar, Docs, Sheets and Tasks.',
    allOrNothing: 'Google grants all of these in one consent screen — it cannot be split per service.',
    consent: [
      { title: 'Read and send your mail', detail: 'Including drafting replies and applying labels on your behalf.' },
      { title: 'Read and edit your files', detail: 'Drive, Docs, Sheets, Slides and Forms you can already open.' },
      { title: 'See and change your calendar', detail: 'Read events, create them, and move them.' },
      { title: 'Read your contacts', detail: 'Used to resolve names to addresses.' },
    ],
  },
  {
    provider: 'lark', name: 'Lark', auth: 'OAuth', memberCanConnect: true,
    blurb: 'Messages, calendar, docs and tasks in your Lark account.',
    consent: [
      { title: 'Read chats you are already in', detail: 'Divo never joins a chat you are not a member of.' },
      { title: 'Send messages as you', detail: 'Messages appear from your account, not a bot.' },
      { title: 'Read and write docs and tasks', detail: 'Limited to documents your account can open.' },
    ],
  },
  {
    provider: 'canva', name: 'Canva', auth: 'OAuth', memberCanConnect: true,
    blurb: 'Open and create designs in your Canva account.',
    consent: [
      { title: 'Open your designs', detail: 'Read design content and metadata.' },
      { title: 'Create and edit designs', detail: 'New designs land in your own Canva account.' },
    ],
  },
  {
    provider: 'airtable', name: 'Airtable', auth: 'OAuth or token', memberCanConnect: true,
    blurb: 'Read and write records in bases you can access.',
    consent: [
      { title: 'Read records and comments', detail: 'Across bases your Airtable account can open.' },
      { title: 'Create and edit records', detail: 'Writes are attributed to your Airtable user.' },
      { title: 'Read base schema', detail: 'Table and field structure, so Divo can find the right column.' },
    ],
  },
  {
    provider: 'zoho', name: 'Zoho', auth: 'OAuth or token', memberCanConnect: false,
    blurb: 'CRM and Books. Connected once for the whole company.',
    consent: [
      { title: 'Read CRM and Books', detail: 'Company-wide connection, shared with the people your admin grants.' },
      { title: 'Create and edit records', detail: 'Only when the connection is not set to read-only.' },
    ],
  },
  {
    provider: 'aitable', name: 'AITable', auth: 'API key', memberCanConnect: false,
    blurb: 'Datasheets and fields. Admin connects it with an API key.',
    consent: [{ title: 'Read and write datasheets', detail: 'Scoped to the workspace behind the key.' }],
  },
]


/* ── Approvals ───────────────────────────────────────── */
export type Approval = {
  id: string
  toolId: string
  action: ActionGroup
  summary: string
  detail: string
  requestedBy: string
  requestedByInitials: string
  requestedAt: string
  expiresIn: string
}

export const AWAITING_ME: Approval[] = [
  {
    id: 'a1', toolId: 'googleGmail', action: 'send',
    summary: 'Send the Q3 vendor reminder to 14 suppliers',
    detail: 'Rohan asked Divo to chase unpaid invoices. The draft is ready and goes out from rohan@acme.co.',
    requestedBy: 'Rohan Iyer', requestedByInitials: 'RI', requestedAt: '9 minutes ago', expiresIn: 'in 51 min',
  },
  {
    id: 'a2', toolId: 'zohoBooks', action: 'update',
    summary: 'Mark 6 invoices as written off',
    detail: 'Total value ₹2,14,800. Divo matched these against the aged-debt sheet Priya shared.',
    requestedBy: 'Priya Nair', requestedByInitials: 'PN', requestedAt: '40 minutes ago', expiresIn: 'in 20 min',
  },
]


/* ── Skills ──────────────────────────────────────────── */
export type Skill = {
  id: string
  name: string
  blurb: string
  scope: 'Private' | 'Finance' | 'Company'
  owner: string
  tools: string[]
  runs30d: number
  updated: string
  /** True when the viewer lacks a tool the skill needs — the reason it is invisible in chat. */
  blockedBy?: string
}

export const SKILLS: Skill[] = [
  {
    id: 's1', name: 'Chase overdue invoices', blurb: 'Finds unpaid invoices past terms and drafts a reminder to each supplier.',
    scope: 'Finance', owner: 'Arjun Shah', tools: ['zohoBooks', 'googleGmail'], runs30d: 63, updated: '3 days ago',
  },
  {
    id: 's2', name: 'Weekly cash position', blurb: 'Pulls balances, writes the Monday summary, and posts it to the Finance group.',
    scope: 'Finance', owner: 'Arjun Shah', tools: ['zohoBooks', 'googleSheets', 'larkMessaging'], runs30d: 12, updated: '1 week ago',
  },
  {
    id: 's3', name: 'Vendor onboarding pack', blurb: 'Collects documents, creates the Drive folder and files the CRM record.',
    scope: 'Company', owner: 'Operations', tools: ['googleDrive', 'zohoCrm'], runs30d: 28, updated: '2 weeks ago',
    blockedBy: 'zohoCrm',
  },
  {
    id: 's4', name: 'My expense summariser', blurb: 'Reads my receipts folder and totals them by category.',
    scope: 'Private', owner: 'You', tools: ['googleDrive', 'googleSheets'], runs30d: 9, updated: 'Yesterday',
  },
  {
    id: 's5', name: 'Board pack assembler', blurb: 'Builds the monthly board deck from the finance sheets.',
    scope: 'Finance', owner: 'Arjun Shah', tools: ['googleSheets', 'googleDrive', 'canvaDesign'], runs30d: 4, updated: '1 month ago',
    blockedBy: 'canvaDesign',
  },
]

/* ── Memory ──────────────────────────────────────────── */
export type Memory = {
  id: string
  text: string
  scope: 'personal' | 'department' | 'company'
  learned: string
  usedCount: number
}

export const MEMORIES: Memory[] = [
  { id: 'm1', text: 'Prefers invoice figures in lakhs, not raw rupees.', scope: 'personal', learned: '2 weeks ago', usedCount: 31 },
  { id: 'm2', text: 'Vendor reminders should always cc finance@acme.co.', scope: 'department', learned: '1 month ago', usedCount: 64 },
  { id: 'm3', text: 'The quarter closes on the 5th, not the last working day.', scope: 'department', learned: '3 weeks ago', usedCount: 22 },
  { id: 'm4', text: 'Never contact Sharma Textiles directly — route through Arjun.', scope: 'personal', learned: '6 days ago', usedCount: 4 },
  { id: 'm5', text: 'Company fiscal year starts in April.', scope: 'company', learned: '2 months ago', usedCount: 190 },
]

/* ── Usage ───────────────────────────────────────────── */
export const MY_USAGE = {
  runs30d: 214,
  runsPrev: 168,
  spend30d: 18.42,
  spendToday: 0.94,
  tokensIn: 4_182_000,
  tokensOut: 291_400,
  cacheSavingsPct: 71,
  budgetUsd: 40,
  daily: [3, 5, 2, 8, 11, 6, 4, 9, 14, 7, 5, 12, 16, 9, 6, 11, 8, 4, 13, 17, 10, 7, 9, 15, 11, 6, 8, 12, 14, 9],
  byModel: [
    { model: 'deepseek-v4-flash', label: 'Flash', calls: 812, costUsd: 6.11 },
    { model: 'deepseek-v4-pro', label: 'Pro', calls: 143, costUsd: 12.31 },
  ],
}

/* ── Activity ────────────────────────────────────────── */


/* ── Data honesty ────────────────────────────────────
   Which panels run on something real. Rendered in the UI as a small marker so
   this mock cannot imply more is built than actually is. */
/**
 * `live`          — this panel is reading a real endpoint right now.
 * `not-wired`     — a real endpoint exists, but this panel still renders
 *                   fixtures. Distinct from the two below on purpose: those
 *                   describe what the backend lacks, this describes what the
 *                   FRONTEND has not done yet, and it is the one that can
 *                   quietly mislead someone signed into the real app.
 * `needs-endpoint`— the data exists, no route serves it to this audience.
 * `needs-backend` — the data does not exist at all.
 */
export type DataState = 'live' | 'not-wired' | 'needs-endpoint' | 'needs-backend'

export const DATA_SOURCES: Record<string, { state: DataState; note: string }> = {
  connections: { state: 'live', note: 'GET /api/desktop/auth/{provider}/status — real today' },
  /**
   * Mounted at the real /connections path while still on fixtures — the only
   * screen in the signed-in app where that is true. The endpoints behind it
   * exist; nothing calls them yet.
   */
  companyConnections: { state: 'not-wired', note: 'The provider endpoints exist. This screen still renders fixtures — wire it before anyone trusts these rows.' },
  connectionCoverage: { state: 'needs-backend', note: 'No route reports per-provider coverage or expiry across a company. Token expiry is stored but never evaluated.' },
  connectionManage: { state: 'live', note: 'GET /{provider}/connections/:id/manage — real today' },
  approvals: { state: 'live', note: 'GET /api/desktop/approvals — real today' },
  permissions: { state: 'live', note: 'GET /api/desktop/auth/tools/:toolId/manage — real today' },
  teamPeople: { state: 'live', note: 'GET /api/desktop/departments/:id/manage — real today' },
  skills: { state: 'live', note: 'gateway op skills.list — real today' },
  profile: { state: 'live', note: 'GET /api/desktop/auth/me + /model-options — real today' },
  myUsage: { state: 'live', note: 'GET /api/desktop/me/usage — real today' },
  myRuns: { state: 'live', note: 'GET /api/desktop/me/runs — real today' },
  teamUsage: { state: 'live', note: 'GET /api/desktop/departments/:id/usage — real today' },
  memory: { state: 'needs-endpoint', note: 'Memory is admin-only. A member cannot list or delete their own memories today.' },
  accessRequest: { state: 'needs-backend', note: 'No access-request model exists. RuntimeApproval is per-tool-call, not a standing grant.' },
  overrideRemoval: { state: 'live', note: 'DELETE /tools/:toolId/departments/:id/members/:userId/actions/:action — real today' },
  /**
   * The Pi artifact extension exists but is switched off, and runtime.test.mjs
   * asserts it stays off. Its mime map is markdown-only, the file never leaves
   * the container workspace, and it badges a desktop sidebar path rather than
   * a URL — so there is nothing for a Lark card to link to and nothing a web
   * viewer could read.
   */
  artifacts: { state: 'needs-backend', note: 'divo_artifact is disabled, markdown-only, and never leaves the container.' },
  artifactSharing: { state: 'needs-backend', note: 'An artifact has no owner or grants today — it is only a file path.' },
  artifactHistory: { state: 'needs-backend', note: 'No versioned storage; the workspace file is overwritten in place.' },
  artifactLive: { state: 'needs-backend', note: 'No event fires when the agent writes a file, so an open viewer cannot update.' },
  reconnect: { state: 'needs-backend', note: 'Token expiry is stored but never evaluated — there is no needs_reauth state to read.' },
}

/* ── Scopes per persona ──────────────────────────────── */
export const SCOPES: Record<Persona, Scope[]> = {
  member: [{ id: 'you', kind: 'you', label: 'Ananya Mehta', detail: 'Your workspace' }],
  manager: [
    { id: 'you', kind: 'you', label: 'Arjun Shah', detail: 'Your workspace' },
    { id: 'team-finance', kind: 'team', label: 'Finance', detail: '6 people · you lead', departmentId: 'd_finance' },
  ],
  admin: [
    { id: 'you', kind: 'you', label: 'Dev Kapoor', detail: 'Your workspace' },
    { id: 'team-finance', kind: 'team', label: 'Finance', detail: '6 people', departmentId: 'd_finance' },
    { id: 'team-ops', kind: 'team', label: 'Operations', detail: '11 people', departmentId: 'd_ops' },
    { id: 'company', kind: 'company', label: 'Acme Technologies', detail: '48 people · whole company' },
  ],
}

export const VIEWER: Record<Persona, { name: string; email: string; initials: string; role: string }> = {
  member: { name: 'Ananya Mehta', email: 'ananya@acme.co', initials: 'AM', role: 'Member · Finance' },
  manager: { name: 'Arjun Shah', email: 'arjun@acme.co', initials: 'AS', role: 'Manager · Finance' },
  admin: { name: 'Dev Kapoor', email: 'dev@acme.co', initials: 'DK', role: 'Company admin' },
}
