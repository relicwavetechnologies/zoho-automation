import type { ToolActionGroup } from './tool-action-groups';

export type ToolCategory = 'crm-read' | 'crm-action' | 'search' | 'workspace' | 'routing';
export type ToolRoutingDomain =
  | 'zoho_crm'
  | 'zoho_books'
  | 'outreach'
  | 'lark'
  | 'lark_task'
  | 'lark_message'
  | 'lark_calendar'
  | 'lark_meeting'
  | 'lark_approval'
  | 'lark_doc'
  | 'lark_base'
  | 'gmail'
  | 'google_drive'
  | 'google_calendar'
  | 'workflow'
  | 'skill'
  | 'web_search'
  | 'context_search'
  | 'workspace'
  | 'document_inspection'
  | 'general';

/** Built-in role slugs (always present for every company). */
export type AiRole = 'MEMBER' | 'COMPANY_ADMIN' | 'SUPER_ADMIN';
export const BUILT_IN_ROLES: AiRole[] = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];

/**
 * TOOL REGISTRY — Single source of truth for all tool definitions and routing.
 *
 * TO ADD A NEW TOOL — touch only this file:
 * 1. Add a new entry to TOOL_REGISTRY with all fields including `domain` and `aliases`
 * 2. Use an existing canonical domain string if the tool fits an existing domain
 * 3. If creating a new domain, add it to mapDomainToRouteType() in routing-heuristics.ts
 *    (that is the only other file you need to touch for a new domain)
 * 4. Add informal names the LLM naturally produces to `aliases` — be generous
 *
 * DO NOT:
 * - Add tool IDs to any hardcoded array outside this file
 * - Add keyword lists to route-contract.ts or routing-heuristics.ts for new tools
 * - Duplicate the domain→tools mapping in graph-tool-facade.ts
 *   (graph-tool-facade.ts can migrate to these exports in a follow-up)
 *
 * DERIVED MAPS (auto-built, never edit directly):
 * - DOMAIN_TO_TOOL_IDS — read this wherever you need "all tools for a domain"
 * - ALIAS_TO_CANONICAL_ID — read this wherever you normalize LLM-suggested tool names
 * - DOMAIN_ALIASES — read this wherever you normalize child-router domain names
 */
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** Which engine(s) implement this tool. */
  engines: ('legacy' | 'vercel')[];
  /** Default permission for built-in roles; custom roles default to same as MEMBER. */
  defaultPermissions: Record<AiRole, boolean>;
  domain: ToolRoutingDomain;
  aliases: string[];
  supportedActionGroups?: ToolActionGroup[];
}

export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    id: 'repo',
    name: 'Repository Inspector',
    description: 'Inspect remote GitHub repositories and retrieve repository files.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['repo', 'repository', 'repositoryInspector', 'githubRepo'],
  },
  {
    id: 'coding',
    name: 'Coding Workspace Tool',
    description: 'Plan and verify local workspace coding tasks that may require approved file or terminal actions.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['coding', 'code', 'workspaceTool', 'terminal', 'workspace'],
  },
  {
    id: 'skill-search',
    name: 'Skill Search',
    description: 'Search and read reusable global and department skills for specialized workflows.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'skill',
    aliases: ['skillSearch', 'skill-search', 'skills', 'searchSkills'],
  },
  {
    id: 'google-gmail',
    name: 'Google Gmail',
    description: 'List, read, draft, and send Gmail messages with optional attachment artifacts using the connected Google account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'gmail',
    aliases: ['googleMail', 'google-mail', 'gmail', 'email', 'googleGmail'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'List, read, download, and upload Google Drive files using the connected account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'google_drive',
    aliases: ['googleDrive', 'google-drive', 'drive', 'google drive'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'List, read, create, update, and delete Google Calendar events using the connected account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'google_calendar',
    aliases: ['googleCalendar', 'google-calendar', 'calendar', 'google calendar'],
  },
  {
    id: 'document-ocr-read',
    name: 'Document OCR Read',
    description: 'List accessible uploaded files, extract machine-readable text, and materialize sendable attachment artifacts from PDFs, docs, CSVs, and scanned images.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['documentOcrRead', 'document-ocr', 'ocr', 'readDocument', 'extractText'],
  },
  {
    id: 'invoice-parser',
    name: 'Invoice Parser',
    description: 'Parse uploaded invoice and bill documents into structured finance fields.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['invoiceParser', 'invoice-parser', 'invoice', 'billParser'],
  },
  {
    id: 'statement-parser',
    name: 'Statement Parser',
    description: 'Parse uploaded bank and account statements into structured rows and totals.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['statementParser', 'statement-parser', 'statement', 'bankStatementParser'],
  },
  {
    id: 'workflow-authoring',
    name: 'Workflow Authoring',
    description: 'Create, plan, save, schedule, list, run, and archive reusable prompts/workflows across desktop and Lark.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workflow',
    aliases: [
      'workflowAuthoring',
      'workflow-authoring',
      'workflowDraft',
      'workflowPlan',
      'workflowBuild',
      'workflowValidate',
      'workflowSave',
      'workflowSchedule',
      'workflowList',
      'workflowArchive',
      'workflowRun',
      'workflow',
    ],
    supportedActionGroups: ['read', 'create', 'update', 'delete', 'execute'],
  },
  {
    id: 'search-zoho-context',
    name: 'Search Zoho Context',
    description: 'Search indexed Zoho CRM records (deals, contacts, tickets) from the vector database.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['searchZohoContext', 'search-zoho-context', 'zohoContext', 'zohoSearch'],
  },
  {
    id: 'read-zoho-records',
    name: 'Read Zoho Records',
    description: 'Fetch formatted Zoho CRM data with risk analysis, health reports, and pipeline summaries.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['readZohoRecords', 'read-zoho-records', 'zohoRecords', 'zohoReadRecords'],
  },
  {
    id: 'zoho-agent',
    name: 'Zoho CRM Agent',
    description: 'Delegate to the Zoho CRM specialist agent for deep CRM data queries.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoAgent', 'zoho-agent', 'zoho'],
  },
  {
    id: 'zoho-write',
    name: 'Zoho CRM Write',
    description: 'Create, update, and delete Zoho CRM records, notes, and attachments after human approval.',
    category: 'crm-action',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoWrite', 'zoho-write', 'zohoAction', 'zoho-action'],
  },
  {
    id: 'zoho-books-read',
    name: 'Zoho Books Read',
    description: 'Read Zoho Books finance records, contacts, vendor payments, bank accounts, credit notes, sales orders, purchase orders, bank transaction match suggestions, and related invoice/email/statement/document metadata. Use the overdue-report path for all-overdue or aging-style invoice requests.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksRead', 'zoho-books-read', 'booksRead', 'zohoBooks', 'books'],
  },
  {
    id: 'zoho-books-write',
    name: 'Zoho Books Write',
    description: 'Create, update, delete, reconcile, categorize, email, remind, import, and status-change Zoho Books records after human approval.',
    category: 'crm-action',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksWrite', 'zoho-books-write', 'booksWrite', 'zohoBooksAction'],
  },
  {
    id: 'zoho-books-agent',
    name: 'Zoho Books Agent',
    description: 'Delegate to the Zoho Books specialist workflow for finance operations.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksAgent', 'zoho-books-agent', 'booksAgent'],
  },
  {
    id: 'read-outreach-publishers',
    name: 'Read Outreach Publishers',
    description:
      'Fetch outreach publisher inventory using structured filters such as client URL, DA/DR, country, and pricing.',
    category: 'search',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'outreach',
    aliases: ['readOutreachPublishers', 'read-outreach-publishers', 'outreachRead', 'publisherSearch'],
  },
  {
    id: 'outreach-agent',
    name: 'Outreach Agent',
    description:
      'Delegate to the outreach specialist agent for publisher filtering and SEO inventory queries.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'outreach',
    aliases: ['outreachAgent', 'outreach-agent', 'outreach'],
  },
  {
    id: 'search-agent',
    name: 'Search Agent',
    description: 'Delegate to the research agent for external web research and exact-site page context.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'web_search',
    aliases: ['searchAgent', 'search-agent', 'webSearchAgent'],
  },
  {
    id: 'search-read',
    name: 'Web Search Read',
    description: 'Search the web via Serper, then fetch result pages to extract page context.',
    category: 'search',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'web_search',
    aliases: ['searchRead', 'search-read', 'webSearch', 'search'],
  },
  {
    id: 'context-search',
    name: 'Context Search',
    description: 'Unified retrieval broker for conversation history, indexed documents, Lark contacts, Zoho context, workspace lookup, web research, and skill discovery.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'context_search',
    aliases: ['contextSearch', 'context-search', 'memorySearch', 'historySearch'],
  },
  {
    id: 'lark-base-read',
    name: 'Lark Base Read',
    description: 'List records from Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseRead', 'lark-base-read', 'larkBase', 'baseRead'],
  },
  {
    id: 'lark-base-write',
    name: 'Lark Base Write',
    description: 'Create or update records in Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseWrite', 'lark-base-write', 'baseWrite'],
  },
  {
    id: 'lark-base-agent',
    name: 'Lark Base Agent',
    description: 'Delegate to the Lark Base specialist for Base record workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseAgent', 'lark-base-agent', 'baseAgent'],
  },
  {
    id: 'lark-task-read',
    name: 'Lark Task Read',
    description: 'List tasks from Lark Tasks, fetch a specific task, or resolve the current task.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskRead', 'lark-task-read', 'larkTask', 'taskRead', 'taskList'],
  },
  {
    id: 'lark-task-write',
    name: 'Lark Task Write',
    description: 'Create, update, or delete tasks in Lark Tasks.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskWrite', 'lark-task-write', 'taskWrite'],
  },
  {
    id: 'lark-task-agent',
    name: 'Lark Task Agent',
    description: 'Delegate to the Lark Tasks specialist for task workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskAgent', 'lark-task-agent', 'taskAgent'],
  },
  {
    id: 'lark-message-read',
    name: 'Lark Message Read',
    description: 'Search Lark workspace users and resolve DM recipients by name, email, open ID, or user ID.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_message',
    aliases: ['larkMessageRead', 'lark-message-read', 'larkMessage', 'messageRead'],
    supportedActionGroups: ['read'],
  },
  {
    id: 'lark-message-write',
    name: 'Lark Message Write',
    description: 'Send Lark direct messages to resolved workspace users after confirmation or workflow approval.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_message',
    aliases: ['larkMessageWrite', 'lark-message-write', 'messageWrite', 'dmSend'],
    supportedActionGroups: ['send'],
  },
  {
    id: 'lark-calendar-list',
    name: 'Lark Calendar List',
    description: 'List available Lark calendars and resolve calendar names to calendar IDs.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarList', 'lark-calendar-list', 'larkCalendar', 'calendarList'],
  },
  {
    id: 'lark-calendar-read',
    name: 'Lark Calendar Read',
    description: 'List events from a Lark Calendar.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarRead', 'lark-calendar-read', 'calendarRead'],
  },
  {
    id: 'lark-calendar-write',
    name: 'Lark Calendar Write',
    description: 'Create, update, or delete events in a Lark Calendar.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarWrite', 'lark-calendar-write', 'calendarWrite'],
  },
  {
    id: 'lark-calendar-agent',
    name: 'Lark Calendar Agent',
    description: 'Delegate to the Lark Calendar specialist for scheduling and calendar workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarAgent', 'lark-calendar-agent', 'calendarAgent'],
  },
  {
    id: 'lark-meeting-read',
    name: 'Lark Meeting Read',
    description: 'List meetings, fetch one meeting, or fetch a Lark minute.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_meeting',
    aliases: ['larkMeetingRead', 'lark-meeting-read', 'larkMeeting', 'meetingRead'],
  },
  {
    id: 'lark-meeting-agent',
    name: 'Lark Meeting Agent',
    description: 'Delegate to the Lark Meetings specialist for meeting lookup and minute retrieval.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_meeting',
    aliases: ['larkMeetingAgent', 'lark-meeting-agent', 'meetingAgent'],
  },
  {
    id: 'lark-approval-read',
    name: 'Lark Approval Read',
    description: 'List or fetch Lark approval instances.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalRead', 'lark-approval-read', 'larkApproval', 'approvalRead'],
  },
  {
    id: 'lark-approval-write',
    name: 'Lark Approval Write',
    description: 'Create a Lark approval instance.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalWrite', 'lark-approval-write', 'approvalWrite'],
  },
  {
    id: 'lark-approval-agent',
    name: 'Lark Approval Agent',
    description: 'Delegate to the Lark Approvals specialist for approval workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalAgent', 'lark-approval-agent', 'approvalAgent'],
  },
  {
    id: 'create-lark-doc',
    name: 'Create Lark Doc',
    description: 'Create a new Lark Doc from grounded content in the current conversation.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['createLarkDoc', 'create-lark-doc', 'larkDocCreate'],
  },
  {
    id: 'edit-lark-doc',
    name: 'Edit Lark Doc',
    description: 'Edit the latest or specified Lark Doc by appending, replacing, patching, or deleting sections.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['editLarkDoc', 'edit-lark-doc', 'larkDocEdit'],
  },
  {
    id: 'lark-doc-agent',
    name: 'Lark Doc Agent',
    description: 'Create and edit Lark Docs from grounded content and reports.',
    category: 'workspace',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['larkDocAgent', 'lark-doc-agent', 'larkDoc', 'docAgent'],
  },
  {
    id: 'zoho-read',
    name: 'Zoho Read',
    description: 'Live Zoho CRM read via MCP or REST with vector augmentation.',
    category: 'crm-read',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoRead', 'zoho-read', 'crmRead'],
  },
  {
    id: 'zoho-action',
    name: 'Zoho Action',
    description: 'Execute write/mutate operations on Zoho CRM. Requires human confirmation.',
    category: 'crm-action',
    engines: ['legacy'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoAction', 'crmAction'],
  },
  {
    id: 'response',
    name: 'Response Agent',
    description: 'Handles greetings and capability questions with low-latency direct replies.',
    category: 'routing',
    engines: ['legacy'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'general',
    aliases: ['response', 'responseAgent'],
  },
  {
    id: 'risk-check',
    name: 'Risk Check',
    description: 'Classifies destructive intent in user messages before action execution.',
    category: 'routing',
    engines: ['legacy'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'general',
    aliases: ['riskCheck', 'risk-check'],
  },
  {
    id: 'lark-response',
    name: 'Lark Responder',
    description: 'Sends progress update messages to Lark channel during task execution.',
    category: 'routing',
    engines: ['legacy'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'general',
    aliases: ['larkResponse', 'lark-response'],
  },
  {
    id: 'share_chat_vectors',
    name: 'Share Chat Knowledge',
    description:
      'Allows a user to promote their personal conversation vectors to company-wide shared context. ' +
      'When enabled, a "Share this chat\'s knowledge" button will appear on bot responses.',
    category: 'workspace',
    engines: ['vercel'],
    // Off for regular members by default; grant explicitly via the Permissions UI.
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'general',
    aliases: ['shareChatVectors', 'share_chat_vectors', 'shareVectors'],
  },
];

export const TOOL_REGISTRY_MAP = new Map(TOOL_REGISTRY.map((t) => [t.id, t]));

const normalizeRegistryLookupKey = (value: string): string =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();

const toDomainAliasCandidates = (value: string): string[] => {
  const normalized = normalizeRegistryLookupKey(value);
  return Array.from(
    new Set([
      value.trim(),
      normalized,
      normalized.replace(/-/g, '_'),
      normalized.replace(/_/g, '-'),
      normalized.replace(/[-_]/g, ''),
    ].filter(Boolean)),
  );
};

export const DOMAIN_TO_TOOL_IDS: Record<string, string[]> = TOOL_REGISTRY.reduce((acc, tool) => {
  if (!acc[tool.domain]) {
    acc[tool.domain] = [];
  }
  acc[tool.domain]!.push(tool.id);
  return acc;
}, {} as Record<string, string[]>);

export const ALIAS_TO_CANONICAL_ID: Record<string, string> = TOOL_REGISTRY.reduce((acc, tool) => {
  for (const candidate of [tool.id, ...tool.aliases]) {
    for (const normalized of toDomainAliasCandidates(candidate)) {
      acc[normalized] = tool.id;
    }
  }
  return acc;
}, {} as Record<string, string>);

export const DOMAIN_ALIASES: Record<string, ToolRoutingDomain> = TOOL_REGISTRY.reduce((acc, tool) => {
  for (const candidate of [tool.domain, tool.id, ...tool.aliases]) {
    for (const normalized of toDomainAliasCandidates(candidate)) {
      acc[normalized] = tool.domain;
    }
  }
  return acc;
}, {} as Record<string, ToolRoutingDomain>);

/** Map from legacy agent key → toolId in the registry */
export const LEGACY_AGENT_TOOL_MAP: Record<string, string> = {
  'zoho-read': 'zoho-read',
  'zoho-action': 'zoho-action',
  'zoho-books-action': 'zoho-books-write',
  'outreach-read': 'read-outreach-publishers',
  'search-read': 'search-read',
  'lark-doc': 'lark-doc-agent',
  response: 'response',
  'risk-check': 'risk-check',
  'lark-response': 'lark-response',
};
