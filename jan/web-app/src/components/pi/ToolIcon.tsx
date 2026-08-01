import {
  BicepsFlexedIcon,
  BookOpenIcon,
  CalendarClockIcon,
  DatabaseIcon,
  FileCode2Icon,
  FilePlusIcon,
  FolderOpenIcon,
  GlobeIcon,
  GraduationCapIcon,
  ListChecksIcon,
  PencilLineIcon,
  ScanTextIcon,
  SearchIcon,
  SquareTerminalIcon,
  TableIcon,
  WrenchIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'

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
  GoogleIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  GoogleTasksIcon,
  LarkIcon,
  SemrushIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { DivoDexMark } from '@/components/DivoDexBrand'
import { resolveToolIdentity } from '@/lib/pi/tool-label'

type IconComponent = ComponentType<{ className?: string }>

/**
 * Google surfaces that have their own recognisable mark. Anything still
 * unmapped under `google*` falls back to the plain Google glyph rather than a
 * wrong one — a generic G is honest, a borrowed mark is not.
 */
const GOOGLE_MARKS: Record<string, IconComponent> = {
  googlegmail: GmailIcon,
  googledrive: GoogleDriveIcon,
  googlecalendar: GoogleCalendarIcon,
  googledocs: GoogleDocsIcon,
  googlesheets: GoogleSheetsIcon,
  googleslides: GoogleSlidesIcon,
  googleforms: GoogleFormsIcon,
  googletasks: GoogleTasksIcon,
  googlecontacts: GoogleContactsIcon,
  googlechat: GoogleChatIcon,
  googleappsscript: GoogleAppsScriptIcon,
}

/**
 * The agent's own file/shell verbs, keyed by the tool's own name. These carry
 * no vendor — what matters is the *action*, so each verb gets a distinct glyph
 * instead of every one of them collapsing into a terminal.
 *
 * `read,write,edit,bash` are the built-ins the desktop allowlists for Company
 * runs (see `COMPANY_TOOL_ALLOWLIST` in `core/pi/runtime.rs`); the rest cover
 * the wider coding-mode set so a Coding run reads the same way.
 */
const ACTION_ICONS: Record<string, IconComponent> = {
  read: BookOpenIcon,
  edit: PencilLineIcon,
  multiedit: PencilLineIcon,
  applypatch: PencilLineIcon,
  write: FilePlusIcon,
  bash: SquareTerminalIcon,
  shell: SquareTerminalIcon,
  grep: SearchIcon,
  search: SearchIcon,
  glob: FolderOpenIcon,
  ls: FolderOpenIcon,
  list: FolderOpenIcon,
  webfetch: GlobeIcon,
  fetch: GlobeIcon,
  todowrite: ListChecksIcon,
  todo: ListChecksIcon,
  divotodos: ListChecksIcon,
  divoartifact: FileCode2Icon,
  divopythonautomation: TableIcon,
}

/**
 * Exact matches on the normalised gateway key, checked before the substring
 * rules below. These are backend tools and ops whose name carries neither a
 * vendor nor a keyword the heuristics can see, so without an entry here they
 * would fall through to the generic wrench.
 *
 * Keys are `toolId`s from `CANONICAL_TOOL_IDS` and ops from `GATEWAY_OPS`
 * (advance-backend), normalised — punctuation stripped, lowercased. The audit
 * test in `__tests__/icon-audit.test.tsx` walks both lists and fails if any
 * entry resolves to the wrench, so a new backend tool cannot ship iconless.
 */
const EXACT_ICONS: Record<string, IconComponent> = {
  // The terminal tool. Arrives as a dispatched toolId rather than a bare
  // `bash`, so ACTION_ICONS never sees it.
  runcommand: SquareTerminalIcon,
  dataprocessor: TableIcon,
  scheduledworkflows: CalendarClockIcon,
  // The governed OMS website inventory. It is a read-only query against a
  // company database rather than a vendor app, so it takes the database glyph
  // — the same mark its expanded tool card uses in `tool-cards/vendors.ts`.
  omssitedata: DatabaseIcon,
  mediaimageocr: ScanTextIcon,
  toolslist: ListChecksIcon,
  // Teach owns the graduation cap wherever it appears — clarification prompts
  // and the learning/context ops alike.
  teachlearningapply: GraduationCapIcon,
  teachcontextget: GraduationCapIcon,
  divoteachclarify: GraduationCapIcon,
}

/**
 * Divo capabilities that are a *lookup* rather than an action — resolving a
 * skill, searching the catalog, retrieving context. These read better as the
 * magnifier than as the Divo mark: the mark says "Divo did something", the
 * magnifier says what. Checked before `DIVO_SUBSTRINGS`, which most of these
 * also match.
 *
 * `memory*` is deliberately excluded — a recall stays branded, so the log
 * still shows plainly when Divo has remembered something.
 */
const SEARCH_SUBSTRINGS = ['search', 'resolve', 'lookup', 'query', 'rag']

/** Divo's own capabilities — memory, persona, RAG, connections. */
const DIVO_SUBSTRINGS = [
  'memory',
  'knowledge',
  'persona',
  'capabilit',
  'connection',
  'context',
  'document',
]

/**
 * Resolves a tool call to a vendor mark.
 *
 * Keyed off the raw identifiers (`toolId` → `op` → tool name), most specific
 * first, because the humanised label loses the vendor. `toolId` wins: a
 * `tools.invoke` dispatch to `zohoBooks` is a Zoho action, not a gateway one.
 *
 * A built-in verb (`read`, `edit`, `bash`, …) only ever arrives as a bare tool
 * name, so it is matched on `name` alone — never on the gateway key, where an
 * op like `skills.list` would otherwise be mistaken for a directory listing.
 */
export function resolveToolIconComponent(
  part: Record<string, unknown>
): IconComponent {
  const { name, op, toolId } = resolveToolIdentity(part)
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '')

  if (!op && !toolId) {
    const action = ACTION_ICONS[normalize(name ?? '')]
    if (action) return action
  }

  const key = normalize(toolId || op || name || '')

  const exact = EXACT_ICONS[key]
  if (exact) return exact

  if (key.startsWith('zoho')) return ZohoIcon
  if (key.startsWith('lark')) return LarkIcon
  if (key.startsWith('canva')) return CanvaIcon
  if (key.startsWith('airtable')) return AirtableIcon
  // Ahead of the lookup rule below on purpose. Semrush IS a research tool, so
  // once its ops grow names like `semrushKeywordSearch` the magnifier would
  // start winning and the vendor would vanish from the log mid-family.
  if (key.startsWith('semrush')) return SemrushIcon
  if (key.startsWith('google')) return GOOGLE_MARKS[key] ?? GoogleIcon
  // Web search keeps the globe — it is the one search that leaves the machine.
  if (key.startsWith('websearch')) return GlobeIcon
  if (
    !key.includes('memory') &&
    SEARCH_SUBSTRINGS.some((token) => key.includes(token))
  ) {
    return SearchIcon
  }
  // Skills get the flexed arm. Checked after the lookup rule on purpose, so
  // `skills.search` / `skills.resolve` stay magnifiers — those read as "finding
  // a skill", while this reads as "using one".
  if (key.includes('skill')) return BicepsFlexedIcon
  if (DIVO_SUBSTRINGS.some((token) => key.includes(token))) return DivoDexMark

  // The gateway's own machinery — lifecycle ops (tools.preflight/prepare/
  // commit) and a call whose op has not streamed in yet — is Divo acting as
  // itself, so it gets the mark rather than a wrench that would read "unknown".
  //
  // Narrowed to ops with no `toolId` on purpose: a `tools.invoke` dispatch to a
  // tool we have no glyph for IS unknown, and branding it would both overclaim
  // and dilute what the mark means elsewhere.
  if (!toolId && (op || name === 'divo_gateway')) return DivoDexMark

  return WrenchIcon
}

/** The vendor mark for a tool-call part, sized for the work-log rows. */
export function ToolIcon({
  part,
  className = 'size-3.5',
}: {
  part: Record<string, unknown>
  className?: string
}) {
  const Icon = resolveToolIconComponent(part)
  return <Icon className={className} />
}
