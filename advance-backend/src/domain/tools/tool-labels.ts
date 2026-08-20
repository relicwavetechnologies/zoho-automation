import type { CanonicalToolId } from './tool-id';
import type { DecisionBrand } from '../decision/decision-subject';

/**
 * How a tool and its actions are named to a human.
 *
 * Approval cards, the approval inbox and the desktop access screens all used to
 * invent their own wording from the raw `toolId` and `actionGroup`, so the same
 * request read as "googleGmail / send" in one place and "Review email before
 * sending" in another. One table, so a person recognises the same action
 * wherever they meet it.
 */
export const ACTION_VERBS: Readonly<Record<string, string>> = {
  read:    'View',
  create:  'Add',
  update:  'Edit',
  delete:  'Delete',
  send:    'Send',
  execute: 'Run',
};

export interface ToolLabel {
  /** Product name, as the user knows it. */
  readonly name: string;
  /** What the tool acts on, in the plural — "email", "records", "events". */
  readonly noun: string;
  /**
   * Whose product it is, for the surfaces that draw a logo.
   *
   * Here rather than in a card because it is the same kind of fact as the name:
   * what a person recognises this as. Absent for Divo's own tools and for the
   * open web — `webSearch` and `knowledge` have no third party behind them, and
   * inventing a mark for them would be the surface lying about who is involved.
   */
  readonly brand?: DecisionBrand;
}

export const TOOL_LABELS: Readonly<Record<CanonicalToolId, ToolLabel>> = {
  larkMessaging:      { name: 'Lark Messaging',   noun: 'messages', brand: 'lark' },
  larkContacts:       { name: 'Lark Contacts',    noun: 'contacts', brand: 'lark' },
  larkTask:           { name: 'Lark Tasks',       noun: 'tasks', brand: 'lark' },
  larkCalendar:       { name: 'Lark Calendar',    noun: 'events', brand: 'lark' },
  larkMeeting:        { name: 'Lark Meetings',    noun: 'meetings', brand: 'lark' },
  larkDoc:            { name: 'Lark Docs',        noun: 'documents', brand: 'lark' },
  larkBase:           { name: 'Lark Base',        noun: 'tables', brand: 'lark' },
  larkApproval:       { name: 'Lark Approvals',   noun: 'approvals', brand: 'lark' },
  googleGmail:        { name: 'Gmail',            noun: 'email', brand: 'gmail' },
  googleDrive:        { name: 'Google Drive',     noun: 'files', brand: 'googleDrive' },
  googleCalendar:     { name: 'Google Calendar',  noun: 'events', brand: 'googleCalendar' },
  googleDocs:         { name: 'Google Docs',      noun: 'documents', brand: 'googleDocs' },
  googleSheets:       { name: 'Google Sheets',    noun: 'spreadsheets', brand: 'googleSheets' },
  googleSlides:       { name: 'Google Slides',    noun: 'presentations', brand: 'googleSlides' },
  googleForms:        { name: 'Google Forms',     noun: 'forms', brand: 'googleForms' },
  googleTasks:        { name: 'Google Tasks',     noun: 'tasks', brand: 'googleTasks' },
  googleContacts:     { name: 'Google Contacts',  noun: 'contacts', brand: 'googleContacts' },
  googleChat:         { name: 'Google Chat',      noun: 'messages', brand: 'googleChat' },
  googleAppsScript:   { name: 'Apps Script',      noun: 'scripts', brand: 'googleAppsScript' },
  canvaDesign:        { name: 'Canva',            noun: 'designs', brand: 'canva' },
  airtableBase:       { name: 'Airtable',         noun: 'bases and records', brand: 'airtable' },
  airtableRecords:    { name: 'Airtable Records', noun: 'records', brand: 'airtable' },
  airtableSchema:     { name: 'Airtable Schema',  noun: 'tables and fields', brand: 'airtable' },
  airtableAutomation: { name: 'Airtable Automations', noun: 'automations', brand: 'airtable' },
  aitableDatasheets:  { name: 'AITable Datasheets', noun: 'records', brand: 'aitable' },
  aitableFields:      { name: 'AITable Fields',   noun: 'fields', brand: 'aitable' },
  zohoCrm:            { name: 'Zoho CRM',         noun: 'records', brand: 'zohoCrm' },
  zohoBooks:          { name: 'Zoho Books',       noun: 'invoices', brand: 'zohoBooks' },
  shopifyAnalytics:   { name: 'Shopify Analytics', noun: 'reports', brand: 'shopify' },
  shopifyOrders:      { name: 'Shopify Orders',    noun: 'orders', brand: 'shopify' },
  shopifyCustomers:   { name: 'Shopify Customers', noun: 'customers', brand: 'shopify' },
  artifactPublish:    { name: 'Publish Artifact',  noun: 'documents' },
  webSearch:          { name: 'Web Search',       noun: 'the web' },
  connectApp:         { name: 'Connect App',      noun: 'provider access' },
  knowledge:          { name: 'Divo Knowledge',   noun: 'knowledge' },
  mailAutomations:    { name: 'Mail Ops',          noun: 'mail rules', brand: 'gmail' },
  scheduledWorkflows: { name: 'Scheduled Work',   noun: 'schedules' },
  semrush:            { name: 'Semrush',          noun: 'SEO data', brand: 'semrush' },
  omsSiteData:        { name: 'OMS Site Data',    noun: 'site inventory' },
  menhoodData:        { name: 'Menhood Data',     noun: 'records' },
};

/** Title case a camelCase or dotted identifier, for anything not in the table. */
export function humaniseToolId(toolId: string): string {
  const spaced = toolId.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function toolLabel(toolId: string): ToolLabel {
  return TOOL_LABELS[toolId as CanonicalToolId] ?? { name: humaniseToolId(toolId), noun: 'items' };
}

/** "Send email", "Edit tables and fields" — the phrase a switch is labelled with. */
export function actionPhrase(toolId: string, action: string): string {
  const { noun } = toolLabel(toolId);
  return `${ACTION_VERBS[action] ?? humaniseToolId(action)} ${noun}`;
}

/**
 * Gateway operations that are worth naming. `tools.invoke` is absent on
 * purpose: it is the operation that simply runs the tool, so it is true of
 * almost every row and printing it says nothing the tool's own name has not.
 */
const GATEWAY_OPS: Readonly<Record<string, string>> = {
  'tools.preflight':       'Checking access',
  'tools.list':            'Listing tools',
  'media.image_ocr':       'Reading a picture',
  'teach.learning.apply':  'Saving what it learnt',
  'skills.search':         'Finding a skill',
  'work.persona.resolve':  'Reading the team profile',
  // Asking a native tool for its schema. Named rather than dropped, because a
  // row that showed only the product would read as though the work had run.
  describe:                'Checking how it works',
};

/**
 * Operations that describe the plumbing rather than the work.
 *
 * `tools.invoke` is the operation that simply runs the tool, so it is true of
 * almost every row; `call` and `call_resolved_sheet` are the same idea in the
 * MCP-backed families, where the operation a reader would recognise is the
 * native tool the call names instead. Printing any of them produced steps
 * captioned "Call" beside a product that had already been named.
 */
const PLUMBING_OPS: ReadonlySet<string> = new Set([
  'tools.invoke',
  'call',
  'call.resolved.sheet',
]);

/**
 * What a governed Divo call is doing, in words.
 *
 * The raw pair reads `omsSiteData · tools.invoke` on a status card — a
 * camelCase identifier and an internal namespace, neither of which is written
 * for the person waiting on the run. The tool table already holds the product
 * name, acronyms and all, so the only new judgement here is which operations
 * deserve saying out loud.
 */
export function gatewayOpPhrase(op?: string): string | undefined {
  // The container and this service ship separately, so an older container may
  // still send the tool id joined onto the operation. Reading the last segment
  // accepts either shape; without it the joined form was translated as though
  // the whole string were an operation, and printed the tool's name twice.
  const operation = op?.split('·').map(part => part.trim()).filter(Boolean).at(-1);
  // Compared on a normalised form so every spelling of the default operation is
  // recognised — including `tools invoke`, which is what an older backend had
  // already made of it before this function existed.
  if (!operation || PLUMBING_OPS.has(operation.toLowerCase().replace(/[^a-z0-9]+/g, '.'))) {
    return undefined;
  }
  return GATEWAY_OPS[operation] ?? humaniseToolId(operation.replace(/^tools\./, ''));
}
