import type { ToolId } from '../../shared/ids';

/** All canonical tool IDs in the system. Add new tools here. */
export const CANONICAL_TOOL_IDS = [
  'larkMessaging',
  'larkContacts',
  'larkTask',
  'larkCalendar',
  'larkDoc',
  'larkBase',
  'larkApproval',
  'googleGmail',
  'googleDrive',
  'googleCalendar',
  'zohoCrm',
  'zohoBooks',
  'contextSearch',
  'webSearch',
  'documentRag',
  'dataProcessor',
] as const;

export type CanonicalToolId = typeof CANONICAL_TOOL_IDS[number];

export type ToolFamily = 'lark' | 'google' | 'zoho' | 'context' | 'rag' | 'data';

export const TOOL_FAMILY_MAP: Record<CanonicalToolId, ToolFamily> = {
  larkMessaging:  'lark',
  larkContacts:   'lark',
  larkTask:       'lark',
  larkCalendar:   'lark',
  larkDoc:        'lark',
  larkBase:       'lark',
  larkApproval:   'lark',
  googleGmail:    'google',
  googleDrive:    'google',
  googleCalendar: 'google',
  zohoCrm:        'zoho',
  zohoBooks:      'zoho',
  contextSearch:  'context',
  webSearch:      'context',
  documentRag:    'rag',
  dataProcessor:  'data',
};

/** Action groups each tool supports. Drives permission defaults. */
export const TOOL_SUPPORTED_ACTIONS: Record<CanonicalToolId, readonly string[]> = {
  larkMessaging:  ['read', 'send'],
  larkContacts:   ['read'],
  larkTask:       ['read', 'create', 'update', 'delete'],
  larkCalendar:   ['read', 'create', 'update', 'delete'],
  larkDoc:        ['read', 'create', 'update'],
  larkBase:       ['read', 'create', 'update', 'delete'],
  larkApproval:   ['read', 'create'],
  googleGmail:    ['read', 'create', 'update', 'delete', 'send'],
  googleDrive:    ['read', 'create', 'update'],
  googleCalendar: ['read', 'create', 'update', 'delete'],
  zohoCrm:        ['read', 'create', 'update', 'delete'],
  zohoBooks:      ['read', 'create', 'update', 'delete'],
  contextSearch:  ['read'],
  webSearch:      ['read'],
  documentRag:    ['read'],
  dataProcessor:  ['read'],
};

/** Default permission per tool per built-in company role. */
export const TOOL_DEFAULT_PERMISSIONS: Record<CanonicalToolId, { MEMBER: boolean; COMPANY_ADMIN: boolean; SUPER_ADMIN: boolean }> = {
  larkMessaging:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkContacts:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkTask:       { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkCalendar:   { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkDoc:        { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkBase:       { MEMBER: false, COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  larkApproval:   { MEMBER: false, COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleGmail:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleDrive:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  googleCalendar: { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  zohoCrm:        { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  zohoBooks:      { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  contextSearch:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  webSearch:      { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  documentRag:    { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
  dataProcessor:  { MEMBER: true,  COMPANY_ADMIN: true,  SUPER_ADMIN: true },
};

export const asToolId = (s: CanonicalToolId): ToolId => s as unknown as ToolId;
