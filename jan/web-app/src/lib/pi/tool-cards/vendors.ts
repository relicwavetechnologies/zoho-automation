import type { ComponentType } from 'react'
import {
  BicepsFlexedIcon,
  BookOpenIcon,
  CalendarClockIcon,
  DatabaseIcon,
  GlobeIcon,
  SearchIcon,
  TableIcon,
} from 'lucide-react'
import {
  AirtableIcon,
  CanvaIcon,
  GmailIcon,
  GoogleAppsScriptIcon,
  GoogleCalendarIcon,
  GoogleChatIcon,
  GoogleContactsIcon,
  GoogleDocsIcon,
  GoogleDriveIcon,
  GoogleFormsIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  GoogleTasksIcon,
  LarkIcon,
  SemrushIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { DivoDexMark } from '@/components/DivoDexBrand'
import type { ToolIdentity } from '@/lib/pi/tool-label'
import { humanizeToolId } from '@/lib/pi/tool-label'
import type { NormalizedOutput } from './output'
import { itemsFromValue, summarizeToolResult, type ToolResultSummary } from './result'
import { argString, extractInvokeArgs } from './invoke-args'
import {
  inferAction,
  inferVerb,
  type DescriptorTable,
  type Verb,
} from './google/types'
import { GMAIL_DESCRIPTORS } from './google/gmail'
import { SHEETS_DESCRIPTORS } from './google/sheets'
import { DRIVE_DESCRIPTORS } from './google/drive'
import { DOCS_DESCRIPTORS } from './google/docs'
import { CALENDAR_DESCRIPTORS, calendarVerbOverride } from './google/calendar'
import { LARK_DESCRIPTORS } from './lark'
import { ZOHO_DESCRIPTORS } from './zoho'
import { AIRTABLE_DESCRIPTORS } from './airtable'
import { MISC_DESCRIPTORS } from './misc'

type IconComponent = ComponentType<{ className?: string }>
type Family = 'google' | 'lark' | 'zoho' | 'canva' | 'airtable' | 'semrush' | 'web' | 'divo'

type VendorDef = {
  appName: string
  Mark: IconComponent
  family: Family
  descriptors?: DescriptorTable
  verbOverride?: (op: string, input: Record<string, unknown> | null) => Verb | undefined
  /**
   * MCP-backed families send `{ op: 'describe' | 'call', nativeTool, input }`,
   * so the real arguments sit one level down and a `describe` call performed no
   * action. Flat families carry their arguments at the top level.
   */
  nativeInputNested?: boolean
}

/**
 * Every canonical tool that renders as a branded card, keyed by the `toolId`
 * that arrives in the gateway `tools.invoke` payload (`CANONICAL_TOOL_IDS` in
 * advance-backend). A call whose toolId is absent here falls through to the
 * generic JSON tool view — the registry returns null, nothing breaks.
 */
const VENDORS: Record<string, VendorDef> = {
  // Google Workspace — the five richly-described apps, plus the rest of the
  // family on generic handling with their own marks.
  googleGmail: { appName: 'Gmail', Mark: GmailIcon, family: 'google', descriptors: GMAIL_DESCRIPTORS },
  googleSheets: { appName: 'Google Sheets', Mark: GoogleSheetsIcon, family: 'google', descriptors: SHEETS_DESCRIPTORS },
  googleDrive: { appName: 'Google Drive', Mark: GoogleDriveIcon, family: 'google', descriptors: DRIVE_DESCRIPTORS },
  googleDocs: { appName: 'Google Docs', Mark: GoogleDocsIcon, family: 'google', descriptors: DOCS_DESCRIPTORS },
  googleCalendar: {
    appName: 'Google Calendar',
    Mark: GoogleCalendarIcon,
    family: 'google',
    descriptors: CALENDAR_DESCRIPTORS,
    verbOverride: calendarVerbOverride,
  },
  googleSlides: { appName: 'Google Slides', Mark: GoogleSlidesIcon, family: 'google' },
  googleForms: { appName: 'Google Forms', Mark: GoogleFormsIcon, family: 'google' },
  googleTasks: { appName: 'Google Tasks', Mark: GoogleTasksIcon, family: 'google' },
  googleContacts: { appName: 'Google Contacts', Mark: GoogleContactsIcon, family: 'google' },
  googleChat: { appName: 'Google Chat', Mark: GoogleChatIcon, family: 'google' },
  googleAppsScript: { appName: 'Apps Script', Mark: GoogleAppsScriptIcon, family: 'google' },

  // Lark / Feishu.
  larkMessaging: { appName: 'Lark Messenger', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.messaging },
  larkContacts: { appName: 'Lark Contacts', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.contacts },
  larkTask: { appName: 'Lark Tasks', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.task },
  larkCalendar: { appName: 'Lark Calendar', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.calendar },
  larkMeeting: { appName: 'Lark Meetings', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.meeting },
  larkDoc: { appName: 'Lark Docs', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.doc },
  larkBase: { appName: 'Lark Base', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.base },
  larkApproval: { appName: 'Lark Approval', Mark: LarkIcon, family: 'lark', descriptors: LARK_DESCRIPTORS.approval },

  // Zoho.
  zohoCrm: { appName: 'Zoho CRM', Mark: ZohoIcon, family: 'zoho', descriptors: ZOHO_DESCRIPTORS.crm },
  zohoBooks: { appName: 'Zoho Books', Mark: ZohoIcon, family: 'zoho', descriptors: ZOHO_DESCRIPTORS.books },

  // Design + research + web.
  canvaDesign: { appName: 'Canva', Mark: CanvaIcon, family: 'canva', descriptors: MISC_DESCRIPTORS.canva },

  // Airtable — MCP-backed, so arguments arrive nested under `input`.
  airtableRecords: { appName: 'Airtable', Mark: AirtableIcon, family: 'airtable', descriptors: AIRTABLE_DESCRIPTORS.records, nativeInputNested: true },
  airtableSchema: { appName: 'Airtable', Mark: AirtableIcon, family: 'airtable', descriptors: AIRTABLE_DESCRIPTORS.schema, nativeInputNested: true },
  airtableAutomation: { appName: 'Airtable', Mark: AirtableIcon, family: 'airtable', descriptors: AIRTABLE_DESCRIPTORS.automation, nativeInputNested: true },
  semrush: { appName: 'Semrush', Mark: SemrushIcon, family: 'semrush', descriptors: MISC_DESCRIPTORS.semrush },
  webSearch: { appName: 'Web Search', Mark: GlobeIcon, family: 'web', descriptors: MISC_DESCRIPTORS.webSearch },

  // Divo's own capabilities.
  contextSearch: { appName: 'Knowledge Search', Mark: SearchIcon, family: 'divo', descriptors: MISC_DESCRIPTORS.contextSearch },
  documentRag: { appName: 'Documents', Mark: BookOpenIcon, family: 'divo', descriptors: MISC_DESCRIPTORS.documentRag },
  memoryRecall: { appName: 'Memory', Mark: DivoDexMark, family: 'divo' },
  memoryPublishing: { appName: 'Memory', Mark: DivoDexMark, family: 'divo' },
  dataProcessor: { appName: 'Data', Mark: TableIcon, family: 'divo', descriptors: MISC_DESCRIPTORS.dataProcessor },
  scheduledWorkflows: { appName: 'Scheduled Work', Mark: CalendarClockIcon, family: 'divo' },
  skillPublishing: { appName: 'Skills', Mark: BicepsFlexedIcon, family: 'divo' },
  omsSiteData: { appName: 'Inventory', Mark: DatabaseIcon, family: 'divo' },
}

/** True when this call belongs to a tool we render as a branded card. */
export function isVendorCard(identity: ToolIdentity): boolean {
  return Boolean(identity.toolId && identity.toolId in VENDORS)
}

export type ToolCardModel = {
  appName: string
  Mark: IconComponent
  verb: Verb
  subject?: string
  /** A describe/introspection call performed no action — the card says so. */
  describe: boolean
  /** Builds the reader-facing result summary once the output has landed. */
  buildSummary: (output: NormalizedOutput) => ToolResultSummary
}

/** Common request fields worth showing when a descriptor names no subject. */
const GENERIC_SUBJECT_KEYS = [
  'query', 'q', 'keyword', 'search', 'search_query',
  'title', 'name', 'subject', 'summary',
  'text', 'content', 'message',
  'domain', 'url',
  'email', 'to',
  'table_id', 'app_token', 'doc_token', 'record_id', 'file_id', 'folder_id',
  'space_id', 'chat_id', 'task_guid',
]

function genericSubject(input: Record<string, unknown> | null): string | undefined {
  const value = argString(input, ...GENERIC_SUBJECT_KEYS)
  return value ? value.slice(0, 120) : undefined
}

/**
 * The card model for a tool call, or null when the tool has no card.
 *
 * Resolution is uniform across vendors: the operation name is `identity.action`
 * (the resolver already digs it out of `nativeTool`/`action`/`op`), the native
 * input is `args.input` for Google or the flat `args` elsewhere, and a Google
 * `op: 'describe'` marks the call as introspection so it never claims the action
 * ran. Unmapped operations still get a model (inferred verb, generic subject),
 * so coverage degrades to "Read Lark Docs" rather than vanishing.
 */
export function resolveToolCardModel(
  identity: ToolIdentity,
  rawInput: unknown
): ToolCardModel | null {
  const vendor = identity.toolId ? VENDORS[identity.toolId] : undefined
  if (!vendor) return null

  const args = extractInvokeArgs(rawInput)
  // The operation name: the resolver's `action` covers nativeTool/action/op;
  // some families instead key on `operation` (Semrush, document RAG), and the
  // flat single-op tools (web/context search, data processor) carry none, so
  // their descriptor lives under the empty-string key.
  const op = identity.action ?? argString(args, 'op', 'action', 'operation') ?? ''
  const nested = vendor.nativeInputNested || vendor.family === 'google'
  const nativeInput = nested ? asRecord(args?.['input']) : args
  const describe = nested && argString(args, 'op') === 'describe'

  const descriptor = vendor.descriptors?.[op]

  let verb: Verb
  let subject: string | undefined
  if (describe) {
    verb = { present: 'Preparing', past: 'Prepared' }
    subject = op ? humanizeToolId(op) : undefined
  } else {
    verb =
      vendor.verbOverride?.(op, nativeInput) ??
      descriptor?.verb ??
      (op ? inferVerb(op) : { present: 'Using', past: 'Used' })
    subject =
      (descriptor?.subject && nativeInput ? descriptor.subject(nativeInput) : undefined) ??
      genericSubject(nativeInput)
  }

  const action = descriptor?.action ?? (op ? inferAction(op) : 'other')
  const countNoun = descriptor?.countNoun
  const isWrite = action === 'create' || action === 'update' || action === 'send'

  const buildSummary = (output: NormalizedOutput): ToolResultSummary => {
    if (describe) return {}
    const base = summarizeToolResult(output, { countNoun, action, subject })
    const override = descriptor?.summary?.({ input: nativeInput ?? {}, output })
    if (override) base.headline = override
    // A write's response often echoes nothing useful — show what was actually
    // written, pulled from the request (e.g. the rows/values sent to a sheet).
    if (!base.items && isWrite && nativeInput) {
      const written = itemsFromValue(nativeInput)
      if (written.items.length) {
        base.items = written.items
        if (written.moreCount) base.moreCount = written.moreCount
      }
    }
    return base
  }

  return { appName: vendor.appName, Mark: vendor.Mark, verb, subject, describe, buildSummary }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
