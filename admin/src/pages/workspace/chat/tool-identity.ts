/**
 * Which mark belongs beside a step in the work log.
 *
 * Ported from the desktop's `components/pi/ToolIcon.tsx`, and the port is the
 * point. This surface had a map from the row's English label to an icon —
 * `{ Gmail: 'gmail', 'Zoho Books': 'zohoBooks' }` — which is the one thing the
 * desktop is careful never to do. The backend labels a governed Gmail call
 * "Google Gmail", so the lookup missed and every branded call in the log
 * rendered as a terminal. That is not a missing entry; it is the wrong key.
 *
 * The right key is the identity the call arrives with: `toolId` first (a
 * `CANONICAL_TOOL_IDS` entry — `googleGmail`, `zohoBooks`), then the container's
 * own `toolName` (`bash`, `read`, `divo_gateway`). Most specific wins, because a
 * `tools.invoke` dispatch to `zohoBooks` is a Zoho action and not a gateway one.
 *
 * Pure on purpose: it returns a key, not a component, so the coverage test can
 * walk every canonical tool without rendering React.
 */
import type { ToolKey } from './tools'

export type ToolIdentity = {
  /** `CANONICAL_TOOL_IDS` entry, for a governed call. */
  toolId?: string
  /** The container's own tool: `bash`, `read`, `divo_gateway`. */
  toolName?: string
}

/**
 * The agent's own file and shell verbs, keyed by the container's tool name.
 *
 * These carry no vendor — what matters is the *action* — so each verb gets its
 * own glyph rather than all of them collapsing into a terminal. Matched on
 * `toolName` alone and only when there is no `toolId`, so a governed op can
 * never be mistaken for a directory listing.
 */
const ACTION_MARKS: Record<string, ToolKey> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  multiedit: 'edit',
  applypatch: 'edit',
  bash: 'terminal',
  shell: 'terminal',
  grep: 'search',
  search: 'search',
  glob: 'files',
  ls: 'files',
  list: 'files',
  webfetch: 'web',
  fetch: 'web',
  todowrite: 'todo',
  todo: 'todo',
  divotodos: 'todo',
  divoartifact: 'artifact',
  /* No entry for `divo_subagents`. It had one — it borrowed the `think` mark,
     which is why the log captioned a fan-out of four agents "Thinking" — and
     it is the one tool that never reaches this table now: `live.ts` reads that
     row as agents rather than as a step, and agents carry a mark derived from
     each one's role. */
  divoskillresolve: 'skill',
  divomemoryrecall: 'divo',
  divomemory: 'divo',
  divomemoryreview: 'divo',
  divoknowledgereview: 'divo',
  divoteachclarify: 'teach',
}

/**
 * Exact matches on the normalised key, checked before the prefix rules.
 *
 * These are tools whose id carries neither a vendor nor a word the heuristics
 * below can see, so without an entry they would fall through to the generic
 * mark. The coverage test walks every canonical tool and fails on a generic
 * result, so a new backend tool cannot ship unmarked.
 */
const EXACT_MARKS: Record<string, ToolKey> = {
  runcommand: 'terminal',
  dataprocessor: 'data',
  scheduledworkflows: 'scheduled',
  mailautomations: 'gmail',
  // Read-only queries against a company database rather than a vendor app.
  omssitedata: 'data',
  menhooddata: 'data',
  mediaimageocr: 'read',
  toolslist: 'todo',
  knowledge: 'knowledge',
  documentrag: 'knowledge',
  contextsearch: 'search',
  teachlearningapply: 'teach',
  teachcontextget: 'teach',
}

/**
 * The same vendors, reached by address instead of by tool id.
 *
 * This table used to live in `answer/links.view.tsx`, which meant a Zoho *link*
 * and a Zoho *step* were answered by two lists that nothing kept in step — and
 * they had already drifted: the link list had no GitHub, no Notion, and could
 * not tell a Google Doc from a Google Sheet. Vendor identity is one question,
 * so it gets one module and two ways in.
 *
 * `path` is what makes the Google entries work at all: every Google editor
 * lives on `docs.google.com`, so the host alone cannot say which product a link
 * points at. Ordered, most specific first.
 */
const DOMAIN_MARKS: { host: RegExp; path?: RegExp; mark: ToolKey }[] = [
  { host: /^(mail|inbox)\.google\.com$/, mark: 'gmail' },
  { host: /^docs\.google\.com$/, path: /^\/(spreadsheets|sheets)\b/, mark: 'sheets' },
  { host: /^docs\.google\.com$/, path: /^\/(presentation|slides)\b/, mark: 'slides' },
  { host: /^docs\.google\.com$/, path: /^\/forms\b/, mark: 'forms' },
  { host: /^docs\.google\.com$/, mark: 'docs' },
  { host: /^sheets\.google\.com$/, mark: 'sheets' },
  { host: /^drive\.google\.com$/, mark: 'drive' },
  { host: /^calendar\.google\.com$/, mark: 'calendar' },
  { host: /^contacts\.google\.com$/, mark: 'contacts' },
  { host: /^tasks\.google\.com$/, mark: 'googleTasks' },
  { host: /^chat\.google\.com$/, mark: 'googleChat' },
  { host: /^script\.google\.com$/, mark: 'appsScript' },
  { host: /(^|\.)google\.(com|co\.[a-z]{2})$/, mark: 'google' },
  { host: /(^|\.)zoho\.(com|in|eu)$/, mark: 'zohoBooks' },
  { host: /(^|\.)(larksuite\.com|feishu\.cn)$/, mark: 'lark' },
  { host: /(^|\.)airtable\.com$/, mark: 'airtable' },
  { host: /(^|\.)canva\.com$/, mark: 'canva' },
  { host: /(^|\.)semrush\.com$/, mark: 'semrush' },
  { host: /(^|\.)(shopify\.com|myshopify\.com)$/, mark: 'shopify' },
]

/**
 * The mark for a web address, or null when this is not a site we know.
 *
 * Null rather than a fallback, for the same reason `toolMarkFor` returns a
 * neutral glyph rather than a borrowed one: the caller can draw something
 * honest about not knowing, and a wrong vendor mark is a claim about where a
 * link goes.
 */
export function markForUrl(href: string): ToolKey | null {
  let url: URL
  try {
    url = new URL(href.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.toLowerCase()
  for (const rule of DOMAIN_MARKS) {
    if (!rule.host.test(host)) continue
    if (rule.path && !rule.path.test(path)) continue
    return rule.mark
  }
  return null
}

/** Google surfaces with their own recognisable mark. */
const GOOGLE_MARKS: Record<string, ToolKey> = {
  googlegmail: 'gmail',
  googledrive: 'drive',
  googlecalendar: 'calendar',
  googledocs: 'docs',
  googlesheets: 'sheets',
  googleslides: 'slides',
  googleforms: 'forms',
  googletasks: 'googleTasks',
  googlecontacts: 'contacts',
  googlechat: 'googleChat',
  googleappsscript: 'appsScript',
}

/**
 * Capabilities that are a *lookup* rather than an action — searching, resolving,
 * retrieving. The magnifier says what happened; the Divo mark would only say
 * that Divo did something. `memory` is excluded on purpose, so a recall stays
 * branded and the log shows plainly when Divo remembered something.
 */
const SEARCH_WORDS = ['search', 'resolve', 'lookup', 'query', 'rag']

/** Divo's own capabilities — memory, persona, knowledge, connections. */
const DIVO_WORDS = ['memory', 'knowledge', 'persona', 'capabilit', 'connection', 'context', 'document']

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The mark for a call, most specific rule first.
 *
 * Falls back to `tool` — a neutral glyph that reads as "something ran" — rather
 * than to a borrowed one. A generic mark is honest about not knowing; a wrong
 * vendor mark is a claim about which system was touched.
 */
export function toolMarkFor(identity: ToolIdentity): ToolKey {
  const toolId = identity.toolId?.trim()
  const toolName = identity.toolName?.trim()

  // A built-in verb only ever arrives as a bare tool name.
  if (!toolId && toolName) {
    const action = ACTION_MARKS[normalize(toolName)]
    if (action) return action
  }

  const key = normalize(toolId || toolName || '')
  if (!key) return 'tool'

  const exact = EXACT_MARKS[key]
  if (exact) return exact

  if (key.startsWith('zohobooks')) return 'zohoBooks'
  if (key.startsWith('zoho')) return 'zohoCrm'
  if (key.startsWith('lark')) return 'lark'
  if (key.startsWith('canva')) return 'canva'
  // Airtable and AITable are different products that share a shape. AITable has
  // no mark of its own here, and Airtable's would name the wrong vendor, so it
  // takes the neutral table glyph.
  if (key.startsWith('airtable')) return 'airtable'
  if (key.startsWith('aitable')) return 'data'
  if (key.startsWith('shopify')) return 'shopify'
  // Ahead of the lookup rule on purpose: Semrush IS a research tool, so once its
  // operations grow names like `semrushKeywordSearch` the magnifier would start
  // winning and the vendor would vanish from the log mid-family.
  if (key.startsWith('semrush')) return 'semrush'
  if (key.startsWith('google')) return GOOGLE_MARKS[key] ?? 'google'
  // The one search that leaves the machine keeps the globe.
  if (key.startsWith('websearch')) return 'web'
  if (!key.includes('memory') && SEARCH_WORDS.some(word => key.includes(word))) return 'search'
  // Checked after the lookup rule, so `skills.search` stays a magnifier — that
  // reads as "finding a skill", while this reads as "using one".
  if (key.includes('skill')) return 'skill'
  if (DIVO_WORDS.some(word => key.includes(word))) return 'divo'

  // The gateway acting as itself — a lifecycle op, or a call whose identity has
  // not arrived. Narrowed to calls with no `toolId`: a dispatch to a tool we
  // have no mark for genuinely IS unknown, and branding it would overclaim.
  if (!toolId && toolName === 'divo_gateway') return 'divo'

  return 'tool'
}
