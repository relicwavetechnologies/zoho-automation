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
  airtableRecords:    { name: 'Airtable Records', noun: 'records' },
  airtableSchema:     { name: 'Airtable Schema',  noun: 'tables and fields' },
  airtableAutomation: { name: 'Airtable Automations', noun: 'automations' },
  zohoCrm:            { name: 'Zoho CRM',         noun: 'records' },
  zohoBooks:          { name: 'Zoho Books',       noun: 'invoices' },
  contextSearch:      { name: 'Context Search',   noun: 'company context' },
  webSearch:          { name: 'Web Search',       noun: 'the web' },
  skillPublishing:    { name: 'Skill Publishing', noun: 'skills' },
  memoryPublishing:   { name: 'Memory Publishing', noun: 'memories' },
  memoryRecall:       { name: 'Memory Recall',    noun: 'memories' },
  documentRag:        { name: 'Document Knowledge', noun: 'documents' },
  dataProcessor:      { name: 'Data Processor',   noun: 'data' },
  scheduledWorkflows: { name: 'Scheduled Work',   noun: 'schedules' },
  semrush:            { name: 'Semrush',          noun: 'SEO data' },
  omsSiteData:        { name: 'OMS Site Data',    noun: 'site inventory' },
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
