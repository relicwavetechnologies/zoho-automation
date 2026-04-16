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
  deprecated?: boolean;
  promptSnippet?: string;
  recoveryHint?: string;
  hitlRequired?: boolean;
  guardrails?: string[];
}

type ToolContractMetadata = Required<Pick<
  ToolDefinition,
  'promptSnippet' | 'recoveryHint' | 'hitlRequired' | 'guardrails'
>>;

const buildReadContract = (
  promptSnippet: string,
  recoveryHint: string,
  guardrails: string[],
): ToolContractMetadata => ({
  promptSnippet,
  recoveryHint,
  hitlRequired: false,
  guardrails,
});

const buildWriteContract = (
  promptSnippet: string,
  recoveryHint: string,
  guardrails: string[],
  hitlRequired = true,
): ToolContractMetadata => ({
  promptSnippet,
  recoveryHint,
  hitlRequired,
  guardrails,
});

const TOOL_CONTRACT_REGISTRY: Record<string, ToolContractMetadata> = {
  repo: buildReadContract(
    'Use Repository Inspector to inspect referenced remote repositories and fetch files as read-only context.',
    'If repository inspection fails, tell the user the repository could not be reached and ask for a valid link or a retry.',
    ['Only inspect repositories the user explicitly referenced', 'Never claim local execution or unverified repository state'],
  ),
  coding: buildWriteContract(
    'Use Coding Workspace Tool for approved local workspace planning, verification, and execution. Inspect before mutating.',
    'If coding workspace actions fail, report the blocked local step and ask the user to retry or approve the required action again.',
    ['Read the relevant local files before editing', 'Never delete or overwrite files without explicit confirmation'],
  ),
  'skill-search': buildReadContract(
    'Use Skill Search to find reusable company or department skills before improvising a specialized workflow.',
    'If skill search fails, continue without the skill lookup and say the skill catalog is temporarily unavailable.',
    ['Prefer existing skills over inventing undocumented procedures', 'Only use skills relevant to the current request'],
  ),
  'google-gmail': buildReadContract(
    'Use Google Gmail to read, draft, and send email through the connected Google account. Confirm recipients and attachments before sending.',
    'If Gmail fails, tell the user email access is unavailable right now and suggest retrying shortly.',
    ['Never send email to guessed recipients', 'Confirm attachments and final wording before any send action'],
  ),
  'google-drive': buildReadContract(
    'Use Google Drive to inspect, download, and upload files in the connected Drive. Verify destination folders before writes.',
    'If Google Drive fails, tell the user Drive access is unavailable and suggest retrying later.',
    ['Only access files relevant to the current company request', 'Do not overwrite or upload files without confirming the target location'],
  ),
  'google-calendar': buildReadContract(
    'Use Google Calendar to inspect and manage calendar events. Translate natural-language dates into concrete event details before changes.',
    'If Google Calendar fails, tell the user calendar access is unavailable and suggest retrying later.',
    ['Never guess attendee addresses or calendar IDs', 'Confirm event timing and attendee impact before destructive updates'],
  ),
  'document-ocr-read': buildReadContract(
    'Use Document OCR Read to extract exact text or attachment artifacts from uploaded files and scanned documents.',
    'If OCR fails, tell the user the document could not be extracted and ask for a clearer file or another retry.',
    ['Only quote text returned by OCR or grounded file reads', 'Do not infer missing text from partial extraction'],
  ),
  'invoice-parser': buildReadContract(
    'Use Invoice Parser to turn uploaded invoice documents into structured finance fields. Validate extracted amounts against the source when possible.',
    'If invoice parsing fails, tell the user the invoice could not be parsed reliably and ask for a clearer file or manual confirmation.',
    ['Never guess missing finance fields', 'Flag low-confidence totals instead of treating them as confirmed'],
  ),
  'statement-parser': buildReadContract(
    'Use Statement Parser to extract structured rows and totals from bank or account statements.',
    'If statement parsing fails, tell the user the statement could not be parsed reliably and ask for a clearer file or manual review.',
    ['Never invent transactions or balances', 'Treat parsed totals as provisional until they match the source document'],
  ),
  'workflow-authoring': buildReadContract(
    'Use Workflow Authoring to draft, validate, save, schedule, run, and archive reusable workflows in the required sequence.',
    'If workflow authoring fails, tell the user workflow management is unavailable and suggest retrying once the workflow service recovers.',
    ['Never schedule a workflow before it validates successfully', 'Always confirm the workflow destination before saving or scheduling'],
  ),
  'search-zoho-context': buildReadContract(
    'Use Search Zoho Context to retrieve indexed Zoho CRM records and related semantic context for the current company.',
    'If Zoho CRM search fails, tell the user CRM search is unavailable and suggest retrying shortly.',
    ['Only retrieve CRM context for the current company', 'Do not treat vector matches as authoritative without checking the returned record details'],
  ),
  'read-zoho-records': buildReadContract(
    'Use Read Zoho Records to fetch live CRM data, summaries, and health analysis from Zoho CRM.',
    'If live Zoho CRM reads fail, tell the user the CRM system is unavailable and suggest retrying in a few minutes.',
    ['Only read CRM data for the current company', 'Never guess module names, record IDs, or missing fields'],
  ),
  'zoho-agent': buildReadContract(
    'Use Zoho CRM Agent for deeper CRM investigation and record analysis when direct reads need specialist handling.',
    'If the Zoho CRM agent fails, tell the user the CRM specialist path is unavailable and fall back to simpler CRM reads if possible.',
    ['Stay within the current company CRM scope', 'Do not mutate CRM data through this delegated read-only path'],
  ),
  'zoho-write': buildWriteContract(
    'Use Zoho CRM Write only for explicit CRM mutations after validating the target record, fields, and intended outcome.',
    'If Zoho CRM writes fail, tell the user no CRM changes were applied and suggest retrying once the CRM system is available.',
    ['Never delete or mutate a CRM record without explicit confirmation', 'Validate the exact record and field names before submission'],
  ),
  'zoho-books-read': buildReadContract(
    'Use Zoho Books Read to inspect finance records, overdue reports, documents, and reconciliation context. Confirm amounts from returned records before downstream actions.',
    'If Zoho Books reads fail, tell the user the finance system is unavailable and suggest retrying in a few minutes.',
    ['Only read finance data for the current company', 'Never guess invoice totals, balances, or module fields'],
  ),
  'zoho-books-write': buildWriteContract(
    'Use Zoho Books Write only for explicit finance mutations after confirming the record, module, status change, and exact amounts involved.',
    'If Zoho Books writes fail, tell the user no finance changes were applied and suggest retrying after the finance system recovers.',
    ['Never mutate finance records without explicit confirmation', 'Always verify amounts, counterparties, and target modules before submission'],
  ),
  'zoho-books-agent': buildReadContract(
    'Use Zoho Books Agent for specialist finance workflows that require deeper tool reasoning across Books modules.',
    'If the Zoho Books agent fails, tell the user the finance specialist path is unavailable and fall back to simpler finance reads if possible.',
    ['Treat returned finance values as source-of-truth only when backed by tool results', 'Do not perform hidden finance mutations through the agent path'],
  ),
  zohoBooks: buildReadContract(
    'Use Zoho Books by selecting the correct finance operation first, then passing exact module or report details.',
    'If Zoho Books fails, tell the user the finance system is unavailable and suggest retrying in a few minutes.',
    ['Choose the exact Books operation before execution', 'Never guess finance module names, IDs, or amounts'],
  ),
  zohoCrm: buildReadContract(
    'Use Zoho CRM by choosing the exact read or write operation first, then supplying the target module and record details.',
    'If Zoho CRM fails, tell the user the CRM system is unavailable and suggest retrying shortly.',
    ['Stay within the current company CRM scope', 'Never guess record IDs, field names, or module names'],
  ),
  outreach: buildReadContract(
    'Use Outreach to search publisher inventory and SEO outreach data with structured filters.',
    'If Outreach fails, tell the user the outreach inventory system is unavailable and suggest retrying later.',
    ['Only use supported structured filters from the request', 'Do not invent publisher metrics or pricing'],
  ),
  contextSearch: buildReadContract(
    'Use Context Search as the unified retrieval broker for history, documents, contacts, CRM context, and approved web research.',
    'If context search fails, say retrieval is unavailable right now and continue only with context already in hand.',
    ['Use the narrowest relevant scope for the request', 'Do not treat retrieved snippets as current facts without checking freshness'],
  ),
  larkBase: buildReadContract(
    'Use Lark Base by selecting whether the task is a read or write operation and targeting the exact base/table first.',
    'If Lark Base fails, tell the user the workspace database is unavailable and suggest retrying later.',
    ['Never guess base IDs, table IDs, or field names', 'Confirm the target base and table before any write action'],
  ),
  larkTask: buildReadContract(
    'Use Lark Task by choosing a read or write operation against the correct task or list context.',
    'If Lark Tasks fails, tell the user task management is unavailable and suggest retrying shortly.',
    ['Never guess assignees or task IDs', 'Confirm ownership and due-date changes before task mutations'],
  ),
  larkMessage: buildReadContract(
    'Use Lark Message to resolve recipients and manage Lark messaging operations. Confirm the destination before sending.',
    'If Lark messaging fails, tell the user Lark messaging is unavailable and suggest retrying later.',
    ['Never DM a guessed recipient', 'Confirm the final destination and content before any outbound send'],
  ),
  larkCalendar: buildReadContract(
    'Use Lark Calendar by choosing list, read, or write operations and translating date/time requests into concrete event parameters.',
    'If Lark Calendar fails, tell the user calendar access is unavailable and suggest retrying later.',
    ['Never guess calendar IDs or attendee lists', 'Confirm event timing and attendee impact before destructive updates'],
  ),
  larkMeeting: buildReadContract(
    'Use Lark Meeting for read-only meeting lookup, minute retrieval, and meeting context inspection.',
    'If Lark Meeting fails, tell the user meeting data is unavailable and suggest retrying later.',
    ['Only read meeting data relevant to the request', 'Do not invent meeting notes or minute content'],
  ),
  larkApproval: buildReadContract(
    'Use Lark Approval by selecting whether the task is a read or create approval flow and validating the approval target first.',
    'If Lark Approval fails, tell the user approval workflows are unavailable and suggest retrying later.',
    ['Never submit an approval with guessed approvers or forms', 'Confirm the approval subject and recipient flow before creation'],
  ),
  larkDoc: buildReadContract(
    'Use Lark Doc to create or edit docs from grounded content only, preserving structure and source accuracy.',
    'If Lark Docs fails, tell the user doc operations are unavailable and suggest retrying later.',
    ['Only write grounded content into docs', 'Do not delete or replace large doc sections without explicit confirmation'],
  ),
  googleWorkspace: buildReadContract(
    'Use Google Workspace by choosing the specific Gmail, Drive, or Calendar operation before execution.',
    'If Google Workspace fails, tell the user Google workspace access is unavailable and suggest retrying later.',
    ['Choose the exact Google product before acting', 'Confirm recipients, destinations, and event details before external side effects'],
  ),
  documentRead: buildReadContract(
    'Use Document Read by selecting OCR, invoice parsing, or statement parsing based on the file type and requested output.',
    'If document reading fails, tell the user the file could not be processed and ask for a clearer file or retry.',
    ['Use the correct document operation for the file type', 'Never invent extracted text or finance values'],
  ),
  workflow: buildReadContract(
    'Use Workflow to author and manage reusable processes after confirming the sequence, destination, and schedule.',
    'If workflow management fails, tell the user workflows are unavailable and suggest retrying later.',
    ['Validate workflows before saving or scheduling', 'Never archive or delete a workflow without explicit confirmation'],
  ),
  devTools: buildReadContract(
    'Use Developer Tools to choose between code, repository, and skill-search workflows for engineering tasks.',
    'If developer tools fail, tell the user the engineering helper surface is unavailable and continue with plain guidance when possible.',
    ['Choose the right developer sub-tool before acting', 'Do not claim code execution or repository state you did not verify'],
  ),
  'read-outreach-publishers': buildReadContract(
    'Use Read Outreach Publishers to query publisher inventory with exact structured filters and return grounded inventory data.',
    'If outreach publisher lookup fails, tell the user the outreach inventory system is unavailable and suggest retrying later.',
    ['Only use supported filters from the request', 'Never invent publisher pricing, DA, DR, or geography'],
  ),
  'outreach-agent': buildReadContract(
    'Use Outreach Agent for specialist publisher search and filtering workflows when basic inventory reads are not enough.',
    'If the outreach agent fails, tell the user the outreach specialist path is unavailable and suggest a retry.',
    ['Stay within structured outreach inventory tasks', 'Do not fabricate publisher metrics or availability'],
  ),
  'search-agent': buildReadContract(
    'Use Search Agent for external web research that needs exact-source lookup and synthesized page context.',
    'If web research fails, tell the user external search is unavailable and suggest retrying later.',
    ['Use explicit sources and cite findings when possible', 'Do not present unverified web claims as confirmed facts'],
  ),
  'search-read': buildReadContract(
    'Use Web Search Read to search the web and fetch result pages for exact page context.',
    'If web search fails, tell the user external search is unavailable and suggest retrying later.',
    ['Prefer fresh and relevant sources', 'Do not summarize pages you did not successfully fetch'],
  ),
  'context-search': buildReadContract(
    'Use Context Search to retrieve relevant company context, history, contacts, documents, and approved public research.',
    'If context search fails, say retrieval is unavailable right now and continue only with current turn context.',
    ['Use the narrowest retrieval scope available', 'Treat recalled snippets as context, not guaranteed current truth'],
  ),
  'lark-base-read': buildReadContract(
    'Use Lark Base Read to inspect records from the specified base and table.',
    'If Lark Base reads fail, tell the user the base records could not be loaded and suggest retrying later.',
    ['Never guess base IDs, table IDs, or field names', 'Only read records relevant to the current request'],
  ),
  'lark-base-write': buildWriteContract(
    'Use Lark Base Write to create or update records only after validating the target base, table, and field mapping.',
    'If Lark Base writes fail, tell the user no base records were changed and suggest retrying later.',
    ['Never mutate records in an unconfirmed table', 'Confirm the fields and affected records before submission'],
  ),
  'lark-base-agent': buildReadContract(
    'Use Lark Base Agent for specialist workflows across Lark Base records and table structures.',
    'If the Lark Base agent fails, tell the user the base specialist path is unavailable and suggest retrying later.',
    ['Stay within the requested base workflow', 'Do not invent base schema details or hidden record mutations'],
  ),
  'lark-task-read': buildReadContract(
    'Use Lark Task Read to inspect tasks, resolve task identities, and load task details.',
    'If Lark Task reads fail, tell the user task data is unavailable and suggest retrying later.',
    ['Only read tasks relevant to the requester context', 'Never guess assignee identity or task IDs'],
  ),
  'lark-task-write': buildWriteContract(
    'Use Lark Task Write to create, update, or delete tasks after confirming assignees, due dates, and task ownership.',
    'If Lark Task writes fail, tell the user no task changes were applied and suggest retrying later.',
    ['Never delete or reassign tasks without explicit confirmation', 'Confirm assignees and due dates before submission'],
  ),
  'lark-task-agent': buildReadContract(
    'Use Lark Task Agent for specialist task workflows that require task-aware reasoning.',
    'If the Lark Task agent fails, tell the user the task specialist path is unavailable and suggest retrying later.',
    ['Keep task actions aligned with explicit user intent', 'Do not invent task IDs, assignees, or due dates'],
  ),
  'lark-message-read': buildReadContract(
    'Use Lark Message Read to resolve recipients and user identities in the Lark workspace before any send step.',
    'If recipient resolution fails, tell the user recipient lookup is unavailable and ask them to retry or specify the user differently.',
    ['Never send to an unresolved recipient', 'Use exact resolved identities from the tool result'],
  ),
  'lark-message-write': buildWriteContract(
    'Use Lark Message Write to send direct messages only after the recipient and content are explicitly confirmed.',
    'If message sending fails, tell the user no Lark message was delivered and suggest retrying later.',
    ['Never send to a guessed or ambiguous recipient', 'Confirm the final content and destination before sending'],
  ),
  'lark-calendar-list': buildReadContract(
    'Use Lark Calendar List to enumerate calendars and resolve human names to concrete calendar IDs.',
    'If calendar listing fails, tell the user calendars could not be loaded and suggest retrying later.',
    ['Use returned calendar IDs rather than guessing', 'Only surface calendars relevant to the request'],
  ),
  'lark-calendar-read': buildReadContract(
    'Use Lark Calendar Read to inspect events from a specified Lark calendar.',
    'If calendar reads fail, tell the user event data is unavailable and suggest retrying later.',
    ['Never invent event details', 'Use exact calendar IDs and time ranges from tool inputs'],
  ),
  'lark-calendar-write': buildWriteContract(
    'Use Lark Calendar Write to create, update, or delete events only after confirming timing, attendees, and the affected calendar.',
    'If calendar writes fail, tell the user no calendar changes were applied and suggest retrying later.',
    ['Never delete or reschedule events without explicit confirmation', 'Confirm the time zone, attendees, and calendar before submission'],
  ),
  'lark-calendar-agent': buildReadContract(
    'Use Lark Calendar Agent for specialist scheduling workflows that need calendar-aware reasoning.',
    'If the calendar agent fails, tell the user the scheduling specialist path is unavailable and suggest retrying later.',
    ['Stay within the requested scheduling workflow', 'Do not invent calendars, attendees, or event identifiers'],
  ),
  'lark-meeting-read': buildReadContract(
    'Use Lark Meeting Read to inspect meetings, fetch meeting details, and retrieve minutes.',
    'If meeting reads fail, tell the user meeting data is unavailable and suggest retrying later.',
    ['Only quote meeting or minute content returned by the tool', 'Do not invent minutes or summaries'],
  ),
  'lark-meeting-agent': buildReadContract(
    'Use Lark Meeting Agent for specialist meeting lookup and minute-retrieval workflows.',
    'If the meeting agent fails, tell the user the meeting specialist path is unavailable and suggest retrying later.',
    ['Keep meeting lookups grounded in actual tool results', 'Do not fabricate meeting IDs or minute content'],
  ),
  'lark-approval-read': buildReadContract(
    'Use Lark Approval Read to inspect approval instances and statuses.',
    'If approval reads fail, tell the user approval data is unavailable and suggest retrying later.',
    ['Only read approvals relevant to the request', 'Never infer approval status without a tool result'],
  ),
  'lark-approval-write': buildWriteContract(
    'Use Lark Approval Write to create approval instances only after confirming the request details and approver path.',
    'If approval creation fails, tell the user no approval was created and suggest retrying later.',
    ['Never submit an approval with guessed form data or approvers', 'Confirm the business context before submission'],
  ),
  'lark-approval-agent': buildReadContract(
    'Use Lark Approval Agent for specialist approval workflows when the approval flow needs deeper reasoning.',
    'If the approval agent fails, tell the user the approval specialist path is unavailable and suggest retrying later.',
    ['Keep approval actions grounded in confirmed request details', 'Do not fabricate approvers or form fields'],
  ),
  'create-lark-doc': buildWriteContract(
    'Use Create Lark Doc to create a new doc from grounded content already verified in the conversation.',
    'If doc creation fails, tell the user no doc was created and suggest retrying later.',
    ['Only create docs from grounded content', 'Do not include unverified data in the generated doc'],
    false,
  ),
  'edit-lark-doc': buildWriteContract(
    'Use Edit Lark Doc to patch or replace doc sections only after confirming the target doc and requested edit scope.',
    'If doc editing fails, tell the user no doc changes were applied and suggest retrying later.',
    ['Confirm the target doc and section before editing', 'Do not delete or replace content beyond the requested scope'],
  ),
  'lark-doc-agent': buildReadContract(
    'Use Lark Doc Agent for specialist document authoring and editing workflows grounded in existing conversation data.',
    'If the doc agent fails, tell the user the doc specialist path is unavailable and suggest retrying later.',
    ['Only write grounded content into docs', 'Do not fabricate report content or doc structure'],
  ),
  'zoho-read': buildReadContract(
    'Use Zoho Read for live CRM reads through supported integrations and returned source-of-truth records.',
    'If Zoho live reads fail, tell the user CRM access is unavailable and suggest retrying later.',
    ['Only read CRM data for the current company', 'Never guess IDs, fields, or missing CRM values'],
  ),
  'zoho-action': buildWriteContract(
    'Use Zoho Action for explicit CRM mutations only after confirming the record, fields, and intended change.',
    'If Zoho CRM actions fail, tell the user no CRM mutations were applied and suggest retrying later.',
    ['Never mutate or delete CRM records without explicit confirmation', 'Validate the exact record and field mapping before submission'],
  ),
  response: buildReadContract(
    'Use Response Agent for low-latency greetings, clarifications, and capability answers without unnecessary tool use.',
    'If the response agent fails, fall back to a short direct answer without extra fanfare.',
    ['Keep replies short and accurate', 'Do not claim tools were used when they were not'],
  ),
  'risk-check': buildReadContract(
    'Use Risk Check to classify potentially destructive intent before allowing risky actions.',
    'If risk classification fails, treat the request conservatively and ask for confirmation before risky actions.',
    ['Err on the side of caution for destructive intent', 'Do not approve risky actions on ambiguous signals'],
  ),
  'lark-response': buildReadContract(
    'Use Lark Responder to send runtime progress updates into Lark during task execution.',
    'If progress updates fail, continue the task and omit the progress message instead of blocking execution.',
    ['Only send status updates relevant to the active task', 'Do not present progress messages as final completion if execution is still running'],
  ),
  share_chat_vectors: buildWriteContract(
    'Use Share Chat Knowledge only when the user explicitly chooses to promote personal chat knowledge into shared company context.',
    'If knowledge sharing fails, tell the user the conversation was not shared and suggest retrying later.',
    ['Never share a conversation without explicit user intent', 'Only promote knowledge into the current company scope'],
  ),
};

export const TOOL_REGISTRY: ToolDefinition[] = [
  {
    ...TOOL_CONTRACT_REGISTRY.repo,
    id: 'repo',
    name: 'Repository Inspector',
    description: 'Inspect remote GitHub repositories and retrieve repository files.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['repo', 'repository', 'repositoryInspector', 'githubRepo'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY.coding,
    id: 'coding',
    name: 'Coding Workspace Tool',
    description: 'Plan and verify local workspace coding tasks that may require approved file or terminal actions.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['coding', 'code', 'workspaceTool', 'terminal', 'workspace'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["skill-search"],
    id: 'skill-search',
    name: 'Skill Search',
    description: 'Search and read reusable global and department skills for specialized workflows.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'skill',
    aliases: ['skillSearch', 'skill-search', 'skills', 'searchSkills'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["google-gmail"],
    id: 'google-gmail',
    name: 'Google Gmail',
    description: 'List, read, draft, and send Gmail messages with optional attachment artifacts using the connected Google account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'gmail',
    aliases: ['googleMail', 'google-mail', 'gmail', 'email', 'googleGmail'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["google-drive"],
    id: 'google-drive',
    name: 'Google Drive',
    description: 'List, read, download, and upload Google Drive files using the connected account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'google_drive',
    aliases: ['googleDrive', 'google-drive', 'drive', 'google drive'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["google-calendar"],
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'List, read, create, update, and delete Google Calendar events using the connected account.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'google_calendar',
    aliases: ['googleCalendar', 'google-calendar', 'calendar', 'google calendar'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["document-ocr-read"],
    id: 'document-ocr-read',
    name: 'Document OCR Read',
    description: 'List accessible uploaded files, extract machine-readable text, and materialize sendable attachment artifacts from PDFs, docs, CSVs, and scanned images.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['documentOcrRead', 'document-ocr', 'ocr', 'readDocument', 'extractText'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["invoice-parser"],
    id: 'invoice-parser',
    name: 'Invoice Parser',
    description: 'Parse uploaded invoice and bill documents into structured finance fields.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['invoiceParser', 'invoice-parser', 'invoice', 'billParser'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["statement-parser"],
    id: 'statement-parser',
    name: 'Statement Parser',
    description: 'Parse uploaded bank and account statements into structured rows and totals.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['statementParser', 'statement-parser', 'statement', 'bankStatementParser'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["workflow-authoring"],
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
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["search-zoho-context"],
    id: 'search-zoho-context',
    name: 'Search Zoho Context',
    description: 'Search indexed Zoho CRM records (deals, contacts, tickets) from the vector database.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['searchZohoContext', 'search-zoho-context', 'zohoContext', 'zohoSearch'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["read-zoho-records"],
    id: 'read-zoho-records',
    name: 'Read Zoho Records',
    description: 'Fetch formatted Zoho CRM data with risk analysis, health reports, and pipeline summaries.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['readZohoRecords', 'read-zoho-records', 'zohoRecords', 'zohoReadRecords'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-agent"],
    id: 'zoho-agent',
    name: 'Zoho CRM Agent',
    description: 'Delegate to the Zoho CRM specialist agent for deep CRM data queries.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoAgent', 'zoho-agent', 'zoho'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-write"],
    id: 'zoho-write',
    name: 'Zoho CRM Write',
    description: 'Create, update, and delete Zoho CRM records, notes, and attachments after human approval.',
    category: 'crm-action',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoWrite', 'zoho-write', 'zohoAction', 'zoho-action'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-books-read"],
    id: 'zoho-books-read',
    name: 'Zoho Books Read',
    description: 'Read Zoho Books finance records, contacts, vendor payments, bank accounts, credit notes, sales orders, purchase orders, bank transaction match suggestions, and related invoice/email/statement/document metadata. Use the overdue-report path for all-overdue or aging-style invoice requests.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksRead', 'zoho-books-read', 'booksRead', 'zohoBooks', 'books'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-books-write"],
    id: 'zoho-books-write',
    name: 'Zoho Books Write',
    description: 'Create, update, delete, reconcile, categorize, email, remind, import, and status-change Zoho Books records after human approval.',
    category: 'crm-action',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksWrite', 'zoho-books-write', 'booksWrite', 'zohoBooksAction'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-books-agent"],
    id: 'zoho-books-agent',
    name: 'Zoho Books Agent',
    description: 'Delegate to the Zoho Books specialist workflow for finance operations.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooksAgent', 'zoho-books-agent', 'booksAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY.zohoBooks,
    id: 'zohoBooks',
    name: 'Zoho Books',
    description: 'Consolidated Zoho Books finance tool. Choose operation first, then pass module/report specifics.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_books',
    aliases: ['zohoBooks', 'zoho-books', 'zoho-books-read', 'zoho-books-write', 'zoho-books-agent', 'booksRead', 'booksWrite', 'booksAgent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.zohoCrm,
    id: 'zohoCrm',
    name: 'Zoho CRM',
    description: 'Consolidated Zoho CRM tool. Choose operation first, then pass module/record specifics.',
    category: 'crm-read',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoCrm', 'zoho-crm', 'search-zoho-context', 'read-zoho-records', 'zoho-read', 'zoho-agent', 'zoho-write'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.outreach,
    id: 'outreach',
    name: 'Outreach',
    description: 'Consolidated outreach inventory tool. Choose search or read operation first.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'outreach',
    aliases: ['outreach', 'read-outreach-publishers', 'outreach-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.contextSearch,
    id: 'contextSearch',
    name: 'Context Search',
    description: 'Unified retrieval broker. operation=search or fetch.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'context_search',
    aliases: ['contextSearch', 'context-search'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkBase,
    id: 'larkBase',
    name: 'Lark Base',
    description: 'Consolidated Lark Base tool. operation=read or write.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBase', 'lark-base-read', 'lark-base-write', 'lark-base-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkTask,
    id: 'larkTask',
    name: 'Lark Task',
    description: 'Consolidated Lark Tasks tool. operation=read or write.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTask', 'lark-task-read', 'lark-task-write', 'lark-task-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkMessage,
    id: 'larkMessage',
    name: 'Lark Message',
    description: 'Consolidated Lark messaging tool. operation=read or write.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_message',
    aliases: ['larkMessage', 'lark-message-read', 'lark-message-write'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkCalendar,
    id: 'larkCalendar',
    name: 'Lark Calendar',
    description: 'Consolidated Lark Calendar tool. operation=list, read, or write.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendar', 'lark-calendar-list', 'lark-calendar-read', 'lark-calendar-write', 'lark-calendar-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkMeeting,
    id: 'larkMeeting',
    name: 'Lark Meeting',
    description: 'Consolidated Lark meeting tool. operation=read.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_meeting',
    aliases: ['larkMeeting', 'lark-meeting-read', 'lark-meeting-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkApproval,
    id: 'larkApproval',
    name: 'Lark Approval',
    description: 'Consolidated Lark approval tool. operation=read or write.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApproval', 'lark-approval-read', 'lark-approval-write', 'lark-approval-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.larkDoc,
    id: 'larkDoc',
    name: 'Lark Doc',
    description: 'Consolidated Lark doc tool. operation=create or edit.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['larkDoc', 'create-lark-doc', 'edit-lark-doc', 'lark-doc-agent'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.googleWorkspace,
    id: 'googleWorkspace',
    name: 'Google Workspace',
    description: 'Consolidated Google Workspace tool. operation=gmail, drive, or calendar.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['googleWorkspace', 'google-gmail', 'google-drive', 'google-calendar'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.documentRead,
    id: 'documentRead',
    name: 'Document Read',
    description: 'Consolidated document-reading tool. operation=ocr, invoiceParse, or statementParse.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'document_inspection',
    aliases: ['documentRead', 'document-ocr-read', 'invoice-parser', 'statement-parser'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.workflow,
    id: 'workflow',
    name: 'Workflow',
    description: 'Consolidated workflow authoring tool. operation=author.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workflow',
    aliases: ['workflow', 'workflow-authoring'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY.devTools,
    id: 'devTools',
    name: 'Developer Tools',
    description: 'Consolidated developer tool surface. operation=code, repo, or skillSearch.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'workspace',
    aliases: ['devTools', 'coding', 'repo', 'skill-search'],
  },
  {
    ...TOOL_CONTRACT_REGISTRY["read-outreach-publishers"],
    id: 'read-outreach-publishers',
    name: 'Read Outreach Publishers',
    description:
      'Fetch outreach publisher inventory using structured filters such as client URL, DA/DR, country, and pricing.',
    category: 'search',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'outreach',
    aliases: ['readOutreachPublishers', 'read-outreach-publishers', 'outreachRead', 'publisherSearch'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["outreach-agent"],
    id: 'outreach-agent',
    name: 'Outreach Agent',
    description:
      'Delegate to the outreach specialist agent for publisher filtering and SEO inventory queries.',
    category: 'search',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'outreach',
    aliases: ['outreachAgent', 'outreach-agent', 'outreach'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["search-agent"],
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
    ...TOOL_CONTRACT_REGISTRY["search-read"],
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
    ...TOOL_CONTRACT_REGISTRY["lark-base-read"],
    id: 'lark-base-read',
    name: 'Lark Base Read',
    description: 'List records from Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseRead', 'lark-base-read', 'larkBase', 'baseRead'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-base-write"],
    id: 'lark-base-write',
    name: 'Lark Base Write',
    description: 'Create or update records in Lark Base / Bitable tables.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseWrite', 'lark-base-write', 'baseWrite'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-base-agent"],
    id: 'lark-base-agent',
    name: 'Lark Base Agent',
    description: 'Delegate to the Lark Base specialist for Base record workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_base',
    aliases: ['larkBaseAgent', 'lark-base-agent', 'baseAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-task-read"],
    id: 'lark-task-read',
    name: 'Lark Task Read',
    description: 'List tasks from Lark Tasks, fetch a specific task, or resolve the current task.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskRead', 'lark-task-read', 'larkTask', 'taskRead', 'taskList'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-task-write"],
    id: 'lark-task-write',
    name: 'Lark Task Write',
    description: 'Create, update, or delete tasks in Lark Tasks.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskWrite', 'lark-task-write', 'taskWrite'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-task-agent"],
    id: 'lark-task-agent',
    name: 'Lark Task Agent',
    description: 'Delegate to the Lark Tasks specialist for task workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_task',
    aliases: ['larkTaskAgent', 'lark-task-agent', 'taskAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-message-read"],
    id: 'lark-message-read',
    name: 'Lark Message Read',
    description: 'Search Lark workspace users and resolve DM recipients by name, email, open ID, or user ID.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_message',
    aliases: ['larkMessageRead', 'lark-message-read', 'larkMessage', 'messageRead'],
    supportedActionGroups: ['read'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-message-write"],
    id: 'lark-message-write',
    name: 'Lark Message Write',
    description: 'Send Lark direct messages to resolved workspace users after confirmation or workflow approval.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_message',
    aliases: ['larkMessageWrite', 'lark-message-write', 'messageWrite', 'dmSend'],
    supportedActionGroups: ['send'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-calendar-list"],
    id: 'lark-calendar-list',
    name: 'Lark Calendar List',
    description: 'List available Lark calendars and resolve calendar names to calendar IDs.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarList', 'lark-calendar-list', 'larkCalendar', 'calendarList'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-calendar-read"],
    id: 'lark-calendar-read',
    name: 'Lark Calendar Read',
    description: 'List events from a Lark Calendar.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarRead', 'lark-calendar-read', 'calendarRead'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-calendar-write"],
    id: 'lark-calendar-write',
    name: 'Lark Calendar Write',
    description: 'Create, update, or delete events in a Lark Calendar.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarWrite', 'lark-calendar-write', 'calendarWrite'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-calendar-agent"],
    id: 'lark-calendar-agent',
    name: 'Lark Calendar Agent',
    description: 'Delegate to the Lark Calendar specialist for scheduling and calendar workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_calendar',
    aliases: ['larkCalendarAgent', 'lark-calendar-agent', 'calendarAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-meeting-read"],
    id: 'lark-meeting-read',
    name: 'Lark Meeting Read',
    description: 'List meetings, fetch one meeting, or fetch a Lark minute.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_meeting',
    aliases: ['larkMeetingRead', 'lark-meeting-read', 'larkMeeting', 'meetingRead'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-meeting-agent"],
    id: 'lark-meeting-agent',
    name: 'Lark Meeting Agent',
    description: 'Delegate to the Lark Meetings specialist for meeting lookup and minute retrieval.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_meeting',
    aliases: ['larkMeetingAgent', 'lark-meeting-agent', 'meetingAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-approval-read"],
    id: 'lark-approval-read',
    name: 'Lark Approval Read',
    description: 'List or fetch Lark approval instances.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalRead', 'lark-approval-read', 'larkApproval', 'approvalRead'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-approval-write"],
    id: 'lark-approval-write',
    name: 'Lark Approval Write',
    description: 'Create a Lark approval instance.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalWrite', 'lark-approval-write', 'approvalWrite'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-approval-agent"],
    id: 'lark-approval-agent',
    name: 'Lark Approval Agent',
    description: 'Delegate to the Lark Approvals specialist for approval workflows.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_approval',
    aliases: ['larkApprovalAgent', 'lark-approval-agent', 'approvalAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["create-lark-doc"],
    id: 'create-lark-doc',
    name: 'Create Lark Doc',
    description: 'Create a new Lark Doc from grounded content in the current conversation.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['createLarkDoc', 'create-lark-doc', 'larkDocCreate'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["edit-lark-doc"],
    id: 'edit-lark-doc',
    name: 'Edit Lark Doc',
    description: 'Edit the latest or specified Lark Doc by appending, replacing, patching, or deleting sections.',
    category: 'workspace',
    engines: ['vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['editLarkDoc', 'edit-lark-doc', 'larkDocEdit'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["lark-doc-agent"],
    id: 'lark-doc-agent',
    name: 'Lark Doc Agent',
    description: 'Create and edit Lark Docs from grounded content and reports.',
    category: 'workspace',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: true, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'lark_doc',
    aliases: ['larkDocAgent', 'lark-doc-agent', 'larkDoc', 'docAgent'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-read"],
    id: 'zoho-read',
    name: 'Zoho Read',
    description: 'Live Zoho CRM read via MCP or REST with vector augmentation.',
    category: 'crm-read',
    engines: ['legacy', 'vercel'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoRead', 'zoho-read', 'crmRead'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY["zoho-action"],
    id: 'zoho-action',
    name: 'Zoho Action',
    description: 'Execute write/mutate operations on Zoho CRM. Requires human confirmation.',
    category: 'crm-action',
    engines: ['legacy'],
    defaultPermissions: { MEMBER: false, COMPANY_ADMIN: true, SUPER_ADMIN: true },
    domain: 'zoho_crm',
    aliases: ['zohoAction', 'crmAction'],
    deprecated: true,
  },
  {
    ...TOOL_CONTRACT_REGISTRY.response,
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
    ...TOOL_CONTRACT_REGISTRY["risk-check"],
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
    ...TOOL_CONTRACT_REGISTRY["lark-response"],
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
    ...TOOL_CONTRACT_REGISTRY.share_chat_vectors,
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

/** Subset of TOOL_REGISTRY with deprecated entries excluded. */
export const ACTIVE_TOOL_REGISTRY = TOOL_REGISTRY.filter((t) => t.deprecated !== true);

export const CONSOLIDATED_TOOL_ALIAS_MAP: Record<string, string> = {
  'zoho-books-read': 'zohoBooks',
  'zoho-books-write': 'zohoBooks',
  'zoho-books-agent': 'zohoBooks',
  'search-zoho-context': 'zohoCrm',
  'read-zoho-records': 'zohoCrm',
  'zoho-read': 'zohoCrm',
  'zoho-agent': 'zohoCrm',
  'zoho-write': 'zohoCrm',
  'lark-task-read': 'larkTask',
  'lark-task-write': 'larkTask',
  'lark-task-agent': 'larkTask',
  'lark-base-read': 'larkBase',
  'lark-base-write': 'larkBase',
  'lark-base-agent': 'larkBase',
  'lark-calendar-list': 'larkCalendar',
  'lark-calendar-read': 'larkCalendar',
  'lark-calendar-write': 'larkCalendar',
  'lark-calendar-agent': 'larkCalendar',
  'lark-approval-read': 'larkApproval',
  'lark-approval-write': 'larkApproval',
  'lark-approval-agent': 'larkApproval',
  'lark-message-read': 'larkMessage',
  'lark-message-write': 'larkMessage',
  'create-lark-doc': 'larkDoc',
  'edit-lark-doc': 'larkDoc',
  'lark-doc-agent': 'larkDoc',
  'lark-meeting-read': 'larkMeeting',
  'lark-meeting-agent': 'larkMeeting',
  'google-gmail': 'googleWorkspace',
  'google-drive': 'googleWorkspace',
  'google-calendar': 'googleWorkspace',
  'context-search': 'contextSearch',
  'document-ocr-read': 'documentRead',
  'invoice-parser': 'documentRead',
  'statement-parser': 'documentRead',
  'read-outreach-publishers': 'outreach',
  'outreach-agent': 'outreach',
  'workflow-authoring': 'workflow',
  coding: 'devTools',
  repo: 'devTools',
  'skill-search': 'devTools',
};

/**
 * Resolves any tool ID (canonical or legacy alias) to its canonical form.
 * Returns the input unchanged when it is already canonical.
 */
export const resolveCanonicalToolId = (id: string): string =>
  CONSOLIDATED_TOOL_ALIAS_MAP[id] ?? id;

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

for (const [domain, toolIds] of Object.entries({
  gmail: ['googleWorkspace'],
  google_drive: ['googleWorkspace'],
  google_calendar: ['googleWorkspace'],
  skill: ['devTools'],
} satisfies Record<string, string[]>)) {
  DOMAIN_TO_TOOL_IDS[domain] = Array.from(new Set([...(DOMAIN_TO_TOOL_IDS[domain] ?? []), ...toolIds]));
}

export const ALIAS_TO_CANONICAL_ID: Record<string, string> = TOOL_REGISTRY.reduce((acc, tool) => {
  for (const candidate of [tool.id, ...tool.aliases]) {
    for (const normalized of toDomainAliasCandidates(candidate)) {
      acc[normalized] = tool.id;
    }
  }
  return acc;
}, {} as Record<string, string>);

for (const [alias, canonical] of Object.entries(CONSOLIDATED_TOOL_ALIAS_MAP)) {
  for (const normalized of toDomainAliasCandidates(alias)) {
    ALIAS_TO_CANONICAL_ID[normalized] = canonical;
  }
}

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
