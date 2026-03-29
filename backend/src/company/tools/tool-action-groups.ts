export type ToolActionGroup =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'send'
  | 'execute';

const TOOL_ACTION_GROUPS: Record<string, ToolActionGroup[]> = {
  repo: ['read'],
  coding: ['read', 'create', 'update', 'delete', 'execute'],
  'skill-search': ['read'],
  'google-gmail': ['read', 'create', 'send'],
  'google-drive': ['read', 'create', 'update', 'delete'],
  'google-calendar': ['read', 'create', 'update', 'delete'],
  'document-ocr-read': ['read'],
  'invoice-parser': ['read'],
  'statement-parser': ['read'],
  'workflow-authoring': ['read', 'create', 'update', 'delete', 'execute'],
  'search-zoho-context': ['read'],
  'read-zoho-records': ['read'],
  'zoho-agent': ['read', 'create', 'update', 'delete'],
  'zoho-write': ['create', 'update', 'delete'],
  'zoho-books-read': ['read'],
  'zoho-books-write': ['create', 'update', 'delete', 'send'],
  'zoho-books-agent': ['read', 'create', 'update', 'delete', 'send'],
  'read-outreach-publishers': ['read'],
  'outreach-agent': ['read'],
  'search-agent': ['read'],
  'search-read': ['read'],
  'search-documents': ['read'],
  'lark-base-read': ['read'],
  'lark-base-write': ['create', 'update', 'delete'],
  'lark-base-agent': ['read', 'create', 'update', 'delete'],
  'lark-task-read': ['read'],
  'lark-task-write': ['create', 'update', 'delete'],
  'lark-task-agent': ['read', 'create', 'update', 'delete'],
  'lark-message-read': ['read'],
  'lark-message-write': ['send'],
  'lark-calendar-list': ['read'],
  'lark-calendar-read': ['read'],
  'lark-calendar-write': ['create', 'update', 'delete'],
  'lark-calendar-agent': ['read', 'create', 'update', 'delete'],
  'lark-meeting-read': ['read'],
  'lark-meeting-agent': ['read'],
  'lark-approval-read': ['read'],
  'lark-approval-write': ['create'],
  'lark-approval-agent': ['read', 'create'],
  'create-lark-doc': ['create'],
  'edit-lark-doc': ['update', 'delete'],
  'lark-doc-agent': ['read', 'create', 'update', 'delete'],
  'response': ['read'],
  'risk-check': ['read'],
  'lark-response': ['read'],
  share_chat_vectors: ['execute'],
};

export const getSupportedToolActionGroups = (toolId: string): ToolActionGroup[] =>
  TOOL_ACTION_GROUPS[toolId] ?? ['read'];

export const isSupportedToolActionGroup = (toolId: string, actionGroup: ToolActionGroup): boolean =>
  getSupportedToolActionGroups(toolId).includes(actionGroup);
