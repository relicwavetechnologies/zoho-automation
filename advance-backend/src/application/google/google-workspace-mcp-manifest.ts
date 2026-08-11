import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import { GOOGLE_SCOPE } from '../../domain/google/google-workspace-scope';

export const GOOGLE_WORKSPACE_MCP_SOURCE = Object.freeze({
  repository: 'https://github.com/taylorwilsdon/google_workspace_mcp',
  version: '1.22.2',
  commit: '59b534201fd16f58b175fc564df6adf4f6b4de71',
});

/**
 * Authentication is resolved before a native MCP tool is called. The private
 * sidecar validates the selected connection's OAuth bearer token and derives
 * the Google principal from that token; identity is never a model argument.
 *
 * Keep this contract as the single source for runtime input validation and
 * generated skill guidance so transport behavior and agent instructions
 * cannot drift independently.
 */
export const GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT = Object.freeze({
  mode: 'external_oauth_bearer' as const,
  identitySource: 'access_token' as const,
  forbiddenToolArguments: ['user_google_email'] as const,
  forbiddenLocalFileArguments: ['path', 'file_path'] as const,
  agentGuidance:
    'The selected Divo connection authenticates the MCP request with its OAuth bearer token. ' +
    'The MCP server derives the Google identity from that token; never send identity fields such as user_google_email in native tool input. ' +
    'Native input must not contain sidecar-local path or file_path fields; provide inline/base64 content or an HTTPS URL.',
});

export type GoogleWorkspaceService =
  | 'gmail'
  | 'drive'
  | 'calendar'
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'forms'
  | 'tasks'
  | 'contacts'
  | 'chat'
  | 'appscript';

export const GOOGLE_SHEETS_DATA_VALIDATION_OPERATION = 'manage_sheet_data_validation' as const;
export const GOOGLE_WORKSPACE_DIVO_OPERATIONS = Object.freeze([
  GOOGLE_SHEETS_DATA_VALIDATION_OPERATION,
] as const);

export interface GoogleWorkspaceProductDefinition {
  readonly service: GoogleWorkspaceService;
  readonly toolId: Extract<CanonicalToolId, `google${string}`>;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tools: readonly string[];
  readonly readScopeGroups: readonly (readonly string[])[];
  readonly writeScopeGroups: readonly (readonly string[])[];
}

const READ_WRITE = {
  gmail: {
    read: [[GOOGLE_SCOPE.gmailReadonly, GOOGLE_SCOPE.gmailModify]],
    write: [[GOOGLE_SCOPE.gmailModify]],
  },
  drive: {
    read: [[GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFull]],
    write: [[GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.driveFull]],
  },
  calendar: {
    read: [[GOOGLE_SCOPE.calendarReadonly, GOOGLE_SCOPE.calendarFull]],
    write: [[GOOGLE_SCOPE.calendarEvents, GOOGLE_SCOPE.calendarFull]],
  },
  docs: {
    read: [
      [GOOGLE_SCOPE.docsReadonly, GOOGLE_SCOPE.docsFull],
      [GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFull],
    ],
    write: [
      [GOOGLE_SCOPE.docsFull],
      [GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.driveFull],
    ],
  },
  sheets: {
    read: [
      [GOOGLE_SCOPE.sheetsReadonly, GOOGLE_SCOPE.sheetsFull],
      [GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFull],
    ],
    write: [
      [GOOGLE_SCOPE.sheetsFull],
      [GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFull],
    ],
  },
  slides: {
    read: [[GOOGLE_SCOPE.slidesReadonly, GOOGLE_SCOPE.slidesFull]],
    write: [[GOOGLE_SCOPE.slidesFull]],
  },
  forms: {
    read: [[GOOGLE_SCOPE.formsBodyReadonly, GOOGLE_SCOPE.formsBody]],
    write: [[GOOGLE_SCOPE.formsBody]],
  },
  tasks: {
    read: [[GOOGLE_SCOPE.tasksReadonly, GOOGLE_SCOPE.tasksFull]],
    write: [[GOOGLE_SCOPE.tasksFull]],
  },
  contacts: {
    read: [[GOOGLE_SCOPE.contactsReadonly, GOOGLE_SCOPE.contactsFull]],
    write: [[GOOGLE_SCOPE.contactsFull]],
  },
  chat: {
    read: [
      [GOOGLE_SCOPE.chatMessagesReadonly, GOOGLE_SCOPE.chatMessages],
      [GOOGLE_SCOPE.chatSpacesReadonly, GOOGLE_SCOPE.chatSpaces],
    ],
    write: [
      [GOOGLE_SCOPE.chatMessages],
      [GOOGLE_SCOPE.chatSpacesReadonly, GOOGLE_SCOPE.chatSpaces],
    ],
  },
  appscript: {
    read: [
      [GOOGLE_SCOPE.scriptProjectsReadonly, GOOGLE_SCOPE.scriptProjects],
      [GOOGLE_SCOPE.driveReadonly, GOOGLE_SCOPE.driveFull],
    ],
    write: [
      [GOOGLE_SCOPE.scriptProjects],
      [GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.driveFull],
    ],
  },
} as const;

export const GOOGLE_WORKSPACE_PRODUCTS: readonly GoogleWorkspaceProductDefinition[] = [
  {
    service: 'gmail',
    toolId: 'googleGmail',
    name: 'Gmail',
    description: 'Search, read, send, draft, organize, and manage Gmail messages, threads, labels, filters, and attachments.',
    category: 'communication',
    tools: [
      'search_gmail_messages', 'get_gmail_message_content', 'get_gmail_messages_content_batch',
      'send_gmail_message', 'get_gmail_attachment_content', 'get_gmail_thread_content',
      'modify_gmail_message_labels', 'list_gmail_labels', 'manage_gmail_label',
      'draft_gmail_message', 'list_gmail_filters', 'manage_gmail_filter',
      'get_gmail_threads_content_batch', 'batch_modify_gmail_message_labels',
    ],
    readScopeGroups: READ_WRITE.gmail.read,
    writeScopeGroups: READ_WRITE.gmail.write,
  },
  {
    service: 'drive',
    toolId: 'googleDrive',
    name: 'Google Drive',
    description: 'Search, read, create, download, organize, import, and share Google Drive files and folders.',
    category: 'documents',
    tools: [
      'search_drive_files', 'get_drive_file_content', 'get_drive_file_download_url',
      'create_drive_file', 'create_drive_folder', 'import_to_google_doc', 'import_to_google_slides',
      'import_to_google_sheets', 'get_drive_shareable_link', 'list_drive_items', 'copy_drive_file',
      'update_drive_file', 'manage_drive_access', 'set_drive_file_permissions',
      'get_drive_file_permissions', 'check_drive_file_public_access',
    ],
    readScopeGroups: READ_WRITE.drive.read,
    writeScopeGroups: READ_WRITE.drive.write,
  },
  {
    service: 'calendar',
    toolId: 'googleCalendar',
    name: 'Google Calendar',
    description: 'List calendars, manage events, check availability, and manage out-of-office and focus time.',
    category: 'calendar',
    tools: ['list_calendars', 'get_events', 'manage_event', 'create_calendar', 'query_freebusy', 'manage_out_of_office', 'manage_focus_time'],
    readScopeGroups: READ_WRITE.calendar.read,
    writeScopeGroups: READ_WRITE.calendar.write,
  },
  {
    service: 'docs',
    toolId: 'googleDocs',
    name: 'Google Docs',
    description: 'Create, read, format, edit, export, structure, and comment on Google Docs.',
    category: 'documents',
    tools: [
      'get_doc_content', 'create_doc', 'modify_doc_text', 'export_doc_to_pdf', 'search_docs',
      'find_and_replace_doc', 'list_docs_in_folder', 'insert_doc_elements', 'update_paragraph_style',
      'get_doc_as_markdown', 'list_document_comments', 'manage_document_comment', 'insert_doc_image',
      'update_doc_headers_footers', 'batch_update_doc', 'inspect_doc_structure',
      'create_table_with_data', 'debug_table_structure', 'manage_doc_tab',
    ],
    readScopeGroups: READ_WRITE.docs.read,
    writeScopeGroups: READ_WRITE.docs.write,
  },
  {
    service: 'sheets',
    toolId: 'googleSheets',
    name: 'Google Sheets',
    description: 'Create, read, write, format, resize, comment on, and manage Google Sheets and tables.',
    category: 'data',
    tools: [
      'create_spreadsheet', 'read_sheet_values', 'modify_sheet_values', 'list_spreadsheets',
      'get_spreadsheet_info', 'format_sheet_range', 'list_sheet_tables', 'create_sheet',
      'append_table_rows', 'resize_sheet_dimensions', 'move_sheet_rows', 'list_spreadsheet_comments',
      'manage_spreadsheet_comment', 'manage_conditional_formatting', GOOGLE_SHEETS_DATA_VALIDATION_OPERATION,
    ],
    readScopeGroups: READ_WRITE.sheets.read,
    writeScopeGroups: READ_WRITE.sheets.write,
  },
  {
    service: 'slides',
    toolId: 'googleSlides',
    name: 'Google Slides',
    description: 'Create, inspect, update, render, and comment on Google Slides presentations.',
    category: 'presentations',
    tools: [
      'create_presentation', 'get_presentation', 'batch_update_presentation', 'get_page',
      'get_page_thumbnail', 'list_presentation_comments', 'manage_presentation_comment',
    ],
    readScopeGroups: READ_WRITE.slides.read,
    writeScopeGroups: READ_WRITE.slides.write,
  },
  {
    service: 'forms',
    toolId: 'googleForms',
    name: 'Google Forms',
    description: 'Create, read, publish, update, and inspect responses for Google Forms.',
    category: 'forms',
    tools: ['create_form', 'get_form', 'list_form_responses', 'set_publish_settings', 'get_form_response', 'batch_update_form'],
    readScopeGroups: READ_WRITE.forms.read,
    writeScopeGroups: READ_WRITE.forms.write,
  },
  {
    service: 'tasks',
    toolId: 'googleTasks',
    name: 'Google Tasks',
    description: 'List and manage Google Tasks, task lists, due dates, status, and task movement.',
    category: 'productivity',
    tools: ['get_task', 'list_tasks', 'manage_task', 'list_task_lists', 'get_task_list', 'manage_task_list'],
    readScopeGroups: READ_WRITE.tasks.read,
    writeScopeGroups: READ_WRITE.tasks.write,
  },
  {
    service: 'contacts',
    toolId: 'googleContacts',
    name: 'Google Contacts',
    description: 'Search, read, create, update, delete, and group Google Contacts.',
    category: 'directory',
    tools: [
      'search_contacts', 'get_contact', 'list_contacts', 'manage_contact', 'list_contact_groups',
      'get_contact_group', 'manage_contacts_batch', 'manage_contact_group',
    ],
    readScopeGroups: READ_WRITE.contacts.read,
    writeScopeGroups: READ_WRITE.contacts.write,
  },
  {
    service: 'chat',
    toolId: 'googleChat',
    name: 'Google Chat',
    description: 'List Google Chat spaces, search and read messages, send messages, react, and download attachments.',
    category: 'communication',
    tools: ['send_message', 'get_messages', 'search_messages', 'create_reaction', 'list_spaces', 'download_chat_attachment'],
    readScopeGroups: READ_WRITE.chat.read,
    writeScopeGroups: READ_WRITE.chat.write,
  },
  {
    service: 'appscript',
    toolId: 'googleAppsScript',
    name: 'Google Apps Script',
    description: 'Create, inspect, update, deploy, execute, version, and monitor Google Apps Script projects.',
    category: 'development',
    tools: [
      'list_script_projects', 'get_script_project', 'get_script_content', 'create_script_project',
      'update_script_content', 'run_script_function', 'generate_trigger_code', 'manage_deployment',
      'list_deployments', 'delete_script_project', 'list_versions', 'create_version', 'get_version',
      'list_script_processes', 'get_script_metrics',
    ],
    readScopeGroups: READ_WRITE.appscript.read,
    writeScopeGroups: READ_WRITE.appscript.write,
  },
] as const;

export const GOOGLE_WORKSPACE_TOOL_IDS = Object.freeze(
  GOOGLE_WORKSPACE_PRODUCTS.map((product) => product.toolId),
);

export const GOOGLE_WORKSPACE_NATIVE_TOOLS = Object.freeze(
  GOOGLE_WORKSPACE_PRODUCTS
    .flatMap((product) => product.tools)
    .filter((tool) => !(GOOGLE_WORKSPACE_DIVO_OPERATIONS as readonly string[]).includes(tool)),
);

const STATIC_ACTIONS: Readonly<Record<string, ToolActionGroup>> = {
  send_gmail_message: 'send',
  draft_gmail_message: 'create',
  modify_gmail_message_labels: 'update',
  batch_modify_gmail_message_labels: 'update',
  create_drive_file: 'create',
  create_drive_folder: 'create',
  copy_drive_file: 'create',
  import_to_google_doc: 'create',
  import_to_google_slides: 'create',
  import_to_google_sheets: 'create',
  update_drive_file: 'update',
  set_drive_file_permissions: 'update',
  create_calendar: 'create',
  manage_out_of_office: 'update',
  manage_focus_time: 'update',
  create_doc: 'create',
  modify_doc_text: 'update',
  find_and_replace_doc: 'update',
  insert_doc_elements: 'update',
  update_paragraph_style: 'update',
  insert_doc_image: 'update',
  update_doc_headers_footers: 'update',
  batch_update_doc: 'update',
  create_table_with_data: 'update',
  create_spreadsheet: 'create',
  modify_sheet_values: 'update',
  format_sheet_range: 'update',
  create_sheet: 'create',
  append_table_rows: 'update',
  resize_sheet_dimensions: 'update',
  move_sheet_rows: 'update',
  manage_conditional_formatting: 'update',
  [GOOGLE_SHEETS_DATA_VALIDATION_OPERATION]: 'update',
  create_presentation: 'create',
  batch_update_presentation: 'update',
  create_form: 'create',
  set_publish_settings: 'update',
  batch_update_form: 'update',
  send_message: 'send',
  create_reaction: 'update',
  create_script_project: 'create',
  update_script_content: 'update',
  run_script_function: 'execute',
  generate_trigger_code: 'execute',
  create_version: 'create',
};

/**
 * New durable work artifacts belong to the company account by default. This
 * deliberately excludes mail, calendars, tasks, and edits to existing files.
 */
const COMPANY_ARTIFACT_CREATE_TOOLS = new Set([
  'create_drive_file',
  'create_drive_folder',
  'copy_drive_file',
  'import_to_google_doc',
  'import_to_google_slides',
  'import_to_google_sheets',
  'create_doc',
  'create_spreadsheet',
  'create_presentation',
  'create_form',
]);

export function prefersCompanyGoogleArtifactAccount(nativeTool: string): boolean {
  return COMPANY_ARTIFACT_CREATE_TOOLS.has(nativeTool);
}

const ACTION_DRIVEN_TOOLS = new Set([
  'manage_gmail_label',
  'manage_gmail_filter',
  'manage_drive_access',
  'manage_event',
  'manage_document_comment',
  'manage_doc_tab',
  'manage_spreadsheet_comment',
  'manage_presentation_comment',
  'manage_task',
  'manage_task_list',
  'manage_contact',
  'manage_contacts_batch',
  'manage_contact_group',
  'manage_deployment',
]);

export function googleWorkspaceActionFor(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): ToolActionGroup {
  if (nativeTool === 'delete_script_project') return 'delete';
  if (ACTION_DRIVEN_TOOLS.has(nativeTool)) {
    const action = typeof input['action'] === 'string' ? input['action'].toLowerCase() : '';
    if (action.includes('delete') || action === 'revoke') return 'delete';
    if (action.includes('create') || action === 'add' || action === 'grant' || action === 'grant_batch') return 'create';
    if (action === 'send') return 'send';
    return 'update';
  }
  return STATIC_ACTIONS[nativeTool] ?? 'read';
}

/**
 * Operation-specific scope policy. The product defaults cover the common API,
 * while these overrides preserve least-privilege compatibility for existing
 * Gmail/Calendar connections and add scopes used by specialist APIs.
 */
export function googleWorkspaceScopeGroupsFor(
  product: GoogleWorkspaceProductDefinition,
  nativeTool: string,
  action: ToolActionGroup,
): readonly (readonly string[])[] {
  if (nativeTool === GOOGLE_SHEETS_DATA_VALIDATION_OPERATION) {
    return [[GOOGLE_SCOPE.sheetsFull]];
  }
  if (nativeTool === 'send_gmail_message') {
    return [[GOOGLE_SCOPE.gmailSend, GOOGLE_SCOPE.gmailModify]];
  }
  if (nativeTool === 'draft_gmail_message') {
    return [[GOOGLE_SCOPE.gmailCompose, GOOGLE_SCOPE.gmailModify]];
  }
  if (nativeTool === 'list_gmail_filters' || nativeTool === 'manage_gmail_filter') {
    return [[GOOGLE_SCOPE.gmailSettingsBasic]];
  }
  if (nativeTool === 'manage_gmail_label') {
    return [[GOOGLE_SCOPE.gmailLabels, GOOGLE_SCOPE.gmailModify]];
  }
  if (nativeTool === 'create_calendar') {
    return [[GOOGLE_SCOPE.calendarFull]];
  }

  const base = action === 'read' ? product.readScopeGroups : product.writeScopeGroups;
  if (nativeTool === 'list_form_responses' || nativeTool === 'get_form_response') {
    return [...base, [GOOGLE_SCOPE.formsResponsesReadonly]];
  }
  if (nativeTool === 'manage_deployment') {
    return [...base, [GOOGLE_SCOPE.scriptDeployments]];
  }
  if (nativeTool === 'list_deployments') {
    return [...base, [GOOGLE_SCOPE.scriptDeploymentsReadonly, GOOGLE_SCOPE.scriptDeployments]];
  }
  if (nativeTool === 'list_script_processes') {
    return [...base, [GOOGLE_SCOPE.scriptProcessesReadonly]];
  }
  if (nativeTool === 'get_script_metrics') {
    return [...base, [GOOGLE_SCOPE.scriptMetrics]];
  }
  if (nativeTool === 'run_script_function') {
    return [
      ...base,
      [GOOGLE_SCOPE.scriptExternalRequest],
      [GOOGLE_SCOPE.scriptApp],
    ];
  }
  return base;
}

export function googleWorkspaceProductByToolId(toolId: string): GoogleWorkspaceProductDefinition | null {
  return GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.toolId === toolId) ?? null;
}

export function googleWorkspaceProductByNativeTool(nativeTool: string): GoogleWorkspaceProductDefinition | null {
  return GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.tools.includes(nativeTool)) ?? null;
}
