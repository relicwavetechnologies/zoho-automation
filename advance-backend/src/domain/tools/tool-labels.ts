import type { CanonicalToolId } from './tool-id';

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
}

export const TOOL_LABELS: Readonly<Record<CanonicalToolId, ToolLabel>> = {
  larkMessaging:      { name: 'Lark Messaging',   noun: 'messages' },
  larkContacts:       { name: 'Lark Contacts',    noun: 'contacts' },
  larkTask:           { name: 'Lark Tasks',       noun: 'tasks' },
  larkCalendar:       { name: 'Lark Calendar',    noun: 'events' },
  larkMeeting:        { name: 'Lark Meetings',    noun: 'meetings' },
  larkDoc:            { name: 'Lark Docs',        noun: 'documents' },
  larkBase:           { name: 'Lark Base',        noun: 'tables' },
  larkApproval:       { name: 'Lark Approvals',   noun: 'approvals' },
  googleGmail:        { name: 'Gmail',            noun: 'email' },
  googleDrive:        { name: 'Google Drive',     noun: 'files' },
  googleCalendar:     { name: 'Google Calendar',  noun: 'events' },
  googleDocs:         { name: 'Google Docs',      noun: 'documents' },
  googleSheets:       { name: 'Google Sheets',    noun: 'spreadsheets' },
  googleSlides:       { name: 'Google Slides',    noun: 'presentations' },
  googleForms:        { name: 'Google Forms',     noun: 'forms' },
  googleTasks:        { name: 'Google Tasks',     noun: 'tasks' },
  googleContacts:     { name: 'Google Contacts',  noun: 'contacts' },
  googleChat:         { name: 'Google Chat',      noun: 'messages' },
  googleAppsScript:   { name: 'Apps Script',      noun: 'scripts' },
  canvaDesign:        { name: 'Canva',            noun: 'designs' },
  airtableBase:       { name: 'Airtable',         noun: 'bases and records' },
  airtableRecords:    { name: 'Airtable Records', noun: 'records' },
  airtableSchema:     { name: 'Airtable Schema',  noun: 'tables and fields' },
  airtableAutomation: { name: 'Airtable Automations', noun: 'automations' },
  aitableDatasheets:  { name: 'AITable Datasheets', noun: 'records' },
  aitableFields:      { name: 'AITable Fields',   noun: 'fields' },
  zohoCrm:            { name: 'Zoho CRM',         noun: 'records' },
  zohoBooks:          { name: 'Zoho Books',       noun: 'invoices' },
  webSearch:          { name: 'Web Search',       noun: 'the web' },
  knowledge:          { name: 'Divo Knowledge',   noun: 'knowledge' },
  dataExport:         { name: 'Secure Data Export', noun: 'exports' },
  mailAutomations:    { name: 'Mail Ops',          noun: 'mail rules' },
  scheduledWorkflows: { name: 'Scheduled Work',   noun: 'schedules' },
  semrush:            { name: 'Semrush',          noun: 'SEO data' },
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
};

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
  if (!operation || operation.toLowerCase().replace(/[^a-z0-9]+/g, '.') === 'tools.invoke') {
    return undefined;
  }
  return GATEWAY_OPS[operation] ?? humaniseToolId(operation.replace(/^tools\./, ''));
}
