export type ToolCategory = 'crm-read' | 'crm-action' | 'search' | 'workspace' | 'routing';

/** Built-in role slugs (always present for every company). */
export type AiRole = 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN';
export const BUILT_IN_ROLES: AiRole[] = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** Which engine(s) implement this tool. 'both' = Mastra + LangGraph. */
  engines: ('mastra' | 'langgraph')[];
  /** Default permission for built-in roles; custom roles default to same as MEMBER. */
  defaultPermissions: Record<AiRole, boolean>;
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    id: 'search-zoho-context',
    name: 'Search Zoho Context',
    description: 'Search indexed Zoho CRM records (deals, contacts, tickets) from the vector database.',
    category: 'crm-read',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'read-zoho-records',
    name: 'Read Zoho Records',
    description: 'Fetch formatted Zoho CRM data with risk analysis, health reports, and pipeline summaries.',
    category: 'crm-read',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'zoho-agent',
    name: 'Zoho CRM Agent',
    description: 'Delegate to the Zoho CRM specialist agent for deep CRM data queries.',
    category: 'crm-read',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'read-outreach-publishers',
    name: 'Read Outreach Publishers',
    description:
      'Fetch outreach publisher inventory using structured filters such as client URL, DA/DR, country, and pricing.',
    category: 'search',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'outreach-agent',
    name: 'Outreach Agent',
    description:
      'Delegate to the outreach specialist agent for publisher filtering and SEO inventory queries.',
    category: 'search',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'search-agent',
    name: 'Search Agent',
    description: 'Delegate to the research agent for external web research, exact-site page context, and internal document retrieval.',
    category: 'search',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'search-read',
    name: 'Web Search Read',
    description: 'Search the web via Serper, then fetch result pages to extract page context.',
    category: 'search',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'search-documents',
    name: 'Search Documents',
    description: 'Search uploaded company documents and private knowledge chunks that the requester is authorized to access.',
    category: 'search',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-base-read',
    name: 'Lark Base Read',
    description: 'List records from Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-base-write',
    name: 'Lark Base Write',
    description: 'Create or update records in Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-base-agent',
    name: 'Lark Base Agent',
    description: 'Delegate to the Lark Base specialist for Base record workflows.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-task-read',
    name: 'Lark Task Read',
    description: 'List tasks from Lark Tasks, fetch a specific task, or resolve the current task.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-people-read',
    name: 'Lark People Read',
    description: 'List and search synced Lark people for assignment, ownership, attendee, and approver resolution.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-task-write',
    name: 'Lark Task Write',
    description: 'Create, update, or delete tasks in Lark Tasks.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-task-agent',
    name: 'Lark Task Agent',
    description: 'Delegate to the Lark Tasks specialist for task workflows.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-calendar-list',
    name: 'Lark Calendar List',
    description: 'List available Lark calendars and resolve calendar names to calendar IDs.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-calendar-read',
    name: 'Lark Calendar Read',
    description: 'List events from a Lark Calendar.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-calendar-write',
    name: 'Lark Calendar Write',
    description: 'Create, update, or delete events in a Lark Calendar.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-calendar-agent',
    name: 'Lark Calendar Agent',
    description: 'Delegate to the Lark Calendar specialist for scheduling and calendar workflows.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-meeting-read',
    name: 'Lark Meeting Read',
    description: 'List meetings, fetch one meeting, or fetch a Lark minute.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-meeting-agent',
    name: 'Lark Meeting Agent',
    description: 'Delegate to the Lark Meetings specialist for meeting lookup and minute retrieval.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-approval-read',
    name: 'Lark Approval Read',
    description: 'List or fetch Lark approval instances.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-approval-write',
    name: 'Lark Approval Write',
    description: 'Create a Lark approval instance.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-approval-agent',
    name: 'Lark Approval Agent',
    description: 'Delegate to the Lark Approvals specialist for approval workflows.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-doc-read',
    name: 'Lark Doc Read',
    description: 'Read or inspect a Lark Doc by document ID or the latest doc in the current conversation.',
    category: 'workspace',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'create-lark-doc',
    name: 'Create Lark Doc',
    description: 'Create a new Lark Doc from grounded content in the current conversation.',
    category: 'workspace',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'edit-lark-doc',
    name: 'Edit Lark Doc',
    description: 'Edit the latest or specified Lark Doc by appending, replacing, patching, or deleting sections.',
    category: 'workspace',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-doc-agent',
    name: 'Lark Doc Agent',
    description: 'Create and edit Lark Docs from grounded content and reports.',
    category: 'workspace',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'zoho-read',
    name: 'Zoho Read',
    description: 'Live Zoho CRM read via MCP or REST with vector augmentation.',
    category: 'crm-read',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'zoho-action',
    name: 'Zoho Action',
    description: 'Execute write/mutate operations on Zoho CRM. Requires human confirmation.',
    category: 'crm-action',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'planner-agent',
    name: 'Planner Agent',
    description: 'Create a structured execution plan for complex multi-step requests before specialist execution.',
    category: 'routing',
    engines: ['mastra'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'response',
    name: 'Response Agent',
    description: 'Handles greetings and capability questions with low-latency direct replies.',
    category: 'routing',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'risk-check',
    name: 'Risk Check',
    description: 'Classifies destructive intent in user messages before action execution.',
    category: 'routing',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'lark-response',
    name: 'Lark Responder',
    description: 'Sends progress update messages to Lark channel during task execution.',
    category: 'routing',
    engines: ['mastra', 'langgraph'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
  {
    id: 'share_chat_vectors',
    name: 'Share Chat Knowledge',
    description:
      'Allows a user to promote their personal conversation vectors to company-wide shared context. ' +
      'When enabled, a "Share this chat\'s knowledge" button will appear on bot responses.',
    category: 'workspace',
    engines: ['mastra', 'langgraph'],
    // Off for regular members by default; grant explicitly via the Permissions UI.
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
  },
];

export const TOOL_REGISTRY_MAP = new Map(TOOL_REGISTRY.map((t) => [t.id, t]));

/** Map from LangGraph agent key → toolId in the registry */
export const LANGGRAPH_AGENT_TOOL_MAP: Record<string, string> = {
  'zoho-read': 'zoho-read',
  'zoho-action': 'zoho-action',
  'outreach-read': 'read-outreach-publishers',
  'search-read': 'search-read',
  'lark-doc': 'lark-doc-agent',
  response: 'response',
  'risk-check': 'risk-check',
  'lark-response': 'lark-response',
};
