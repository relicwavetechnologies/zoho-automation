/**
 * Every tool a run can touch, and the mark that identifies it.
 *
 * The marks are the real vendor logos — the same `brand-icons` set the desktop
 * work log renders — not lucide stand-ins. A step that says "Google Sheets"
 * carries the Sheets mark, so a reader scanning the trace recognises what Divo
 * touched before reading a single word.
 *
 * Divo's own capabilities (thinking, the local workspace, knowledge search)
 * have no vendor, so they take lucide glyphs and are drawn in ink. That
 * asymmetry is deliberate: coloured mark = someone else's system, grey glyph =
 * Divo's own. It is the fastest way to read what left the building.
 *
 * The set used to hold only the handful of vendors a demo transcript mentioned,
 * which meant most real calls had nowhere to land. It now covers every
 * `CANONICAL_TOOL_IDS` family plus the container's own verbs, and
 * `tool-identity.ts` decides which one a call gets — from the call's identity,
 * never from its English label.
 */
import type { ComponentType, SVGProps } from 'react'
import {
  BookOpen, CalendarClock, FilePlus, FolderOpen, Globe, GraduationCap, ListChecks,
  PencilLine, Search, Sparkles, Table, Terminal, Wrench,
} from 'lucide-react'
import {
  AirtableIcon, CanvaIcon, GmailIcon, GoogleAppsScriptIcon, GoogleCalendarIcon,
  GoogleChatIcon, GoogleContactsIcon, GoogleDocsIcon, GoogleDriveIcon, GoogleFormsIcon,
  GoogleIcon, GoogleSheetsIcon, GoogleSlidesIcon, GoogleTasksIcon, LarkIcon,
  SemrushIcon, ShopifyIcon, ZohoIcon,
} from '@/components/brand-icons'

export type ToolKey =
  /* Divo's own, and the container's verbs. */
  | 'think' | 'divo' | 'knowledge' | 'search' | 'skill' | 'teach' | 'todo'
  | 'terminal' | 'read' | 'write' | 'edit' | 'files' | 'artifact' | 'data'
  | 'scheduled' | 'web' | 'tool'
  /* Google. */
  | 'google' | 'gmail' | 'sheets' | 'drive' | 'calendar' | 'docs' | 'slides'
  | 'forms' | 'googleTasks' | 'contacts' | 'googleChat' | 'appsScript'
  /* Everyone else. */
  | 'zohoBooks' | 'zohoCrm' | 'lark' | 'airtable' | 'canva' | 'semrush' | 'shopify'

type Mark = ComponentType<SVGProps<SVGSVGElement>>

type ToolDef = {
  /** What the step header calls it. */
  app: string
  Mark: Mark
  /** True for Divo's own capabilities — drawn in ink, not in vendor colour. */
  own?: boolean
  /**
   * Width ÷ height, for marks that are not square.
   *
   * Zoho's is a wordmark on a 1024×365 viewBox. Forced into a square box it
   * letterboxes down to a 14×5 smudge that reads as dirt on the screen. Given
   * its real ratio it renders as a small wordmark instead, which is legible
   * and is how Zoho actually presents itself.
   */
  aspect?: number
}

const ZOHO_ASPECT = 1024 / 365

const TOOLS: Record<ToolKey, ToolDef> = {
  /* Divo's own capabilities and the container's verbs — ink, not colour. */
  think: { app: 'Thinking', Mark: Sparkles, own: true },
  divo: { app: 'Divo', Mark: Sparkles, own: true },
  knowledge: { app: 'Knowledge', Mark: BookOpen, own: true },
  search: { app: 'Search', Mark: Search, own: true },
  skill: { app: 'Skill', Mark: GraduationCap, own: true },
  teach: { app: 'Teach', Mark: GraduationCap, own: true },
  todo: { app: 'Plan', Mark: ListChecks, own: true },
  terminal: { app: 'Terminal', Mark: Terminal, own: true },
  read: { app: 'Reading', Mark: BookOpen, own: true },
  write: { app: 'Writing', Mark: FilePlus, own: true },
  edit: { app: 'Editing', Mark: PencilLine, own: true },
  files: { app: 'Files', Mark: FolderOpen, own: true },
  artifact: { app: 'Artifact', Mark: FilePlus, own: true },
  data: { app: 'Data', Mark: Table, own: true },
  scheduled: { app: 'Scheduled work', Mark: CalendarClock, own: true },
  web: { app: 'Web search', Mark: Globe, own: true },
  /* Something ran and we cannot say what. Honest, rather than borrowed. */
  tool: { app: 'Tool', Mark: Wrench, own: true },

  google: { app: 'Google', Mark: GoogleIcon },
  gmail: { app: 'Gmail', Mark: GmailIcon },
  sheets: { app: 'Google Sheets', Mark: GoogleSheetsIcon },
  drive: { app: 'Google Drive', Mark: GoogleDriveIcon },
  calendar: { app: 'Google Calendar', Mark: GoogleCalendarIcon },
  docs: { app: 'Google Docs', Mark: GoogleDocsIcon },
  slides: { app: 'Google Slides', Mark: GoogleSlidesIcon },
  forms: { app: 'Google Forms', Mark: GoogleFormsIcon },
  googleTasks: { app: 'Google Tasks', Mark: GoogleTasksIcon },
  contacts: { app: 'Google Contacts', Mark: GoogleContactsIcon },
  googleChat: { app: 'Google Chat', Mark: GoogleChatIcon },
  appsScript: { app: 'Apps Script', Mark: GoogleAppsScriptIcon },

  zohoBooks: { app: 'Zoho Books', Mark: ZohoIcon, aspect: ZOHO_ASPECT },
  zohoCrm: { app: 'Zoho CRM', Mark: ZohoIcon, aspect: ZOHO_ASPECT },

  lark: { app: 'Lark', Mark: LarkIcon },
  airtable: { app: 'Airtable', Mark: AirtableIcon },
  canva: { app: 'Canva', Mark: CanvaIcon },
  semrush: { app: 'Semrush', Mark: SemrushIcon },
  shopify: { app: 'Shopify', Mark: ShopifyIcon },
}

export function tool(key: ToolKey) {
  return TOOLS[key]
}

/**
 * A tool's mark at a given size.
 *
 * Vendor marks bring their own colour and opt out of the global lucide
 * `stroke-width`; Divo's own glyphs inherit `currentColor` so they sit in
 * whatever ink weight the row around them is using.
 */
export function ToolMark({ name, size = 14 }: { name: ToolKey; size?: number }) {
  const { Mark, own, aspect } = TOOLS[name] ?? TOOLS.tool
  return (
    <Mark
      width={aspect ? Math.round(size * aspect) : size}
      height={size}
      className={own ? 'shrink-0' : 'bui-mark shrink-0'}
      aria-hidden
    />
  )
}
