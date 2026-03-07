export type ToolCategory = 'crm-read' | 'crm-action' | 'search' | 'routing';

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
    description: 'Delegate to the web search agent for external research with exact-site page context.',
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
];

export const TOOL_REGISTRY_MAP = new Map(TOOL_REGISTRY.map((t) => [t.id, t]));

/** Map from LangGraph agent key → toolId in the registry */
export const LANGGRAPH_AGENT_TOOL_MAP: Record<string, string> = {
  'zoho-read': 'zoho-read',
  'zoho-action': 'zoho-action',
  'outreach-read': 'read-outreach-publishers',
  'search-read': 'search-read',
  response: 'response',
  'risk-check': 'risk-check',
  'lark-response': 'lark-response',
};
