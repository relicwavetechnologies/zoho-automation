/**
 * Every tool a run can touch, and the mark that identifies it.
 *
 * Vendor identity is delegated to the shared BrandMark system. A step that says
 * "Google Sheets" carries the product mark, so a reader scanning the trace
 * recognises what Divo touched before reading a single word.
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
import { BrandMark } from '@/components/admin/brand-mark'
import type { BrandKey } from '@/components/admin/brand-catalog'

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
  Mark?: Mark
  brand?: BrandKey
  /** True for Divo's own capabilities — drawn in ink, not in vendor colour. */
  own?: boolean
}

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

  google: { app: 'Google', brand: 'google' },
  gmail: { app: 'Gmail', brand: 'gmail' },
  sheets: { app: 'Google Sheets', brand: 'googleSheets' },
  drive: { app: 'Google Drive', brand: 'googleDrive' },
  calendar: { app: 'Google Calendar', brand: 'googleCalendar' },
  docs: { app: 'Google Docs', brand: 'googleDocs' },
  slides: { app: 'Google Slides', brand: 'googleSlides' },
  forms: { app: 'Google Forms', brand: 'googleForms' },
  googleTasks: { app: 'Google Tasks', brand: 'googleTasks' },
  contacts: { app: 'Google Contacts', brand: 'googleContacts' },
  googleChat: { app: 'Google Chat', brand: 'googleChat' },
  appsScript: { app: 'Apps Script', brand: 'googleAppsScript' },

  zohoBooks: { app: 'Zoho Books', brand: 'zohoBooks' },
  zohoCrm: { app: 'Zoho CRM', brand: 'zohoCrm' },
  lark: { app: 'Lark', brand: 'lark' },
  airtable: { app: 'Airtable', brand: 'airtable' },
  canva: { app: 'Canva', brand: 'canva' },
  semrush: { app: 'Semrush', brand: 'semrush' },
  shopify: { app: 'Shopify', brand: 'shopify' },
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
export function ToolMark({
  name, size = 14, dim,
}: {
  name: ToolKey
  size?: number
  /**
   * Hold the mark back until the row is pointed at.
   *
   * Only vendor marks take it. Divo's own glyphs are drawn in `currentColor`,
   * so a row that dims its text dims them already — fading those a second time
   * leaves a smudge where a settled log row's leading mark should be.
   */
  dim?: boolean
}) {
  const { Mark, own, brand } = TOOLS[name] ?? TOOLS.tool
  const held = dim && !own
  if (brand) return <BrandMark brand={brand} size={size} dim={dim} className="bui-mark" />
  if (!Mark) return null
  return (
    <Mark
      width={size}
      height={size}
      className={[
        own ? '' : 'bui-mark',
        'shrink-0',
        held ? 'opacity-70 transition-opacity duration-100 group-hover:opacity-100' : '',
      ].filter(Boolean).join(' ')}
      aria-hidden
    />
  )
}
