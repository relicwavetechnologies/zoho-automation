/**
 * Turning one recorded tool call into a line a person can read.
 *
 * The trace used to render whatever `actorKey` said, which for every vendor
 * call is `divo_gateway` — the transport, not the tool. So a run that fetched
 * Semrush organic positions, searched the web, pulled a domain overview and ran
 * a keyword gap against four competitors displayed as five identical grey rows
 * reading `divo_gateway · tools.invoke`. The information was always in the
 * payload; the screen was showing the envelope and hiding the letter.
 *
 * A gateway dispatch is `{op: 'tools.invoke', payload: {toolId, args, skillId}}`
 * (`toolsInvokePayloadSchema` in advance-backend). `toolId` is the real tool and
 * `args` carries the subject — a domain, a query, a spreadsheet id. Both are
 * lifted here.
 *
 * Everything is defensive. This reads persisted JSON from runs going back a
 * week, across schema changes, so an unrecognised shape must degrade to
 * something legible rather than throw inside a render.
 */

const ACRONYMS = new Set(['id', 'ai', 'api', 'crm', 'url', 'seo', 'sql', 'csv', 'pdf', 'gst'])

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** `divo_skill_view` → "Skill view"; `webSearch` → "Web search". */
export function humanizeId(id: string): string {
  const words = id
    .replace(/^divo[_-]/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word))
  const [first, ...rest] = words
  return first ? [first[0]!.toUpperCase() + first.slice(1), ...rest].join(' ') : id
}

/** Vendor display names where humanizing the id alone reads wrong. */
const VENDOR_NAMES: Record<string, string> = {
  semrush: 'Semrush',
  webSearch: 'Web search',
  googleGmail: 'Gmail',
  googleDrive: 'Drive',
  googleSheets: 'Sheets',
  googleDocs: 'Docs',
  googleCalendar: 'Calendar',
  larkMessaging: 'Lark messages',
  larkDoc: 'Lark docs',
  larkBase: 'Lark Base',
  larkTask: 'Lark tasks',
  larkCalendar: 'Lark calendar',
  airtableRecords: 'Airtable',
  aitableRecords: 'AITable',
  zohoBooks: 'Zoho Books',
  zohoCrm: 'Zoho CRM',
  canvaDesign: 'Canva',
  dataExport: 'Data export',
  mailAutomations: 'Mail rules',
}

/**
 * Which arg is the subject of the call.
 *
 * Ordered by how much it tells a reader: a search query says more than a
 * domain, which says more than an id. First match wins, so a Semrush call keyed
 * by `operation` still surfaces its `domain` as the subject beneath it.
 */
const SUBJECT_KEYS = [
  'query', 'q', 'search', 'prompt',
  // Plural forms matter: a keyword-gap call carries `targets`, and without it
  // the most interesting step in the run — four competitors compared — showed
  // its verb and nothing else.
  'targets', 'domains', 'urls', 'competitors',
  'domain', 'url', 'link',
  'email', 'to', 'chatId',
  'path', 'file', 'fileName',
  'title', 'name',
  'spreadsheetId', 'documentId', 'baseId', 'tableId', 'recordId',
  'skillId', 'id',
]

/** The verb of the call, when the args name one. */
const OPERATION_KEYS = ['operation', 'op', 'action', 'method', 'nativeTool', 'verb']

const asText = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String)
    return parts.length ? parts.join(', ') : null
  }
  return null
}

const pick = (args: Record<string, unknown>, keys: string[]): { key: string; value: string } | null => {
  for (const key of keys) {
    const text = asText(args[key])
    if (text) return { key, value: text }
  }
  return null
}

/**
 * Whether this call changed anything.
 *
 * The old badge came from a regex over the *transport* name, so
 * `divo_gateway` classified as "read" no matter what it carried — every row
 * wore a blue READ, including the writes. A wrong safety label is worse than
 * none, so anything that cannot be established returns null and renders no
 * badge at all.
 */
export type StepAction = 'read' | 'write' | null

const WRITE_WORDS = /\b(write|create|update|send|delete|remove|edit|patch|insert|move|archive|publish|upload|export|revoke|assign)\b/
const READ_WORDS = /\b(read|get|list|view|search|find|lookup|fetch|query|overview|positions|gap|preview|describe|compare|comparison|analysis|report|audit|stats|metrics|history|trends?|keywords?|backlinks)\b/

export function actionOf(toolId: string, operation: string | null): StepAction {
  const subject = `${operation ?? ''} ${toolId}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase()
  if (WRITE_WORDS.test(subject)) return 'write'
  if (READ_WORDS.test(subject)) return 'read'
  return null
}

export type TraceStepView = {
  /** What ran, in the reader's words: "Semrush", "Web search". */
  title: string
  /** The subject of the call — a query, a domain, an id. */
  detail: string | null
  /** The verb, when the args named one: "organic positions". */
  operation: string | null
  action: StepAction
  /** True when this went through the gateway, so the raw view says so. */
  viaGateway: boolean
}

/**
 * Reads one recorded step. Never throws.
 *
 * `input` is whatever was persisted — usually the object, occasionally a JSON
 * string from an older writer, sometimes a partial. Anything unreadable falls
 * back to the tool name, which is exactly what the screen showed before, so the
 * worst case here is no worse than the old best case.
 */
export function readStep(toolName: string, input: unknown): TraceStepView {
  const parsed = typeof input === 'string'
    ? (() => { try { return JSON.parse(input) as unknown } catch { return null } })()
    : input
  const root = asRecord(parsed)
  const payload = asRecord(root?.['payload'])

  // A `tools.invoke` nests the real call under payload.args; a direct gateway op
  // keeps its params at the payload root.
  const invokedTool = asText(payload?.['toolId'])
  const args = asRecord(payload?.['args']) ?? payload ?? root
  const viaGateway = Boolean(payload) || asText(root?.['op']) !== null

  const effectiveId = invokedTool ?? toolName
  const title = VENDOR_NAMES[effectiveId] ?? humanizeId(effectiveId)

  if (!args) return { title, detail: null, operation: null, action: actionOf(effectiveId, null), viaGateway }

  const operationRaw = pick(args, OPERATION_KEYS)
  // `tools.invoke` is the transport's own verb, never the tool's — showing it
  // is how every row ended up captioned identically.
  const operation = operationRaw && operationRaw.value !== 'tools.invoke'
    ? humanizeId(operationRaw.value).toLowerCase()
    : null

  const subject = pick(args, SUBJECT_KEYS.filter((k) => k !== operationRaw?.key))
  const detail = subject ? truncate(shortenIds(subject.value), 96) : null

  return { title, detail, operation, action: actionOf(effectiveId, operationRaw?.value ?? null), viaGateway }
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/**
 * A full UUID tells a reader nothing and eats the row.
 *
 * Shortened rather than dropped: two `skill view` steps differ only by their
 * id, and without any of it they fold into one line that claims a single call
 * happened twice. Eight characters is enough to see they are different.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const shortenIds = (text: string): string => (UUID.test(text) ? `${text.slice(0, 8)}…` : text)

/**
 * Collapses a run of identical calls into one row with a count.
 *
 * An agent polling the same endpoint eight times is one fact, not eight rows —
 * and eight identical rows push the steps that differ off the screen. Only
 * consecutive identical steps fold, so the order of what happened survives.
 */
export function foldRepeats<T>(steps: T[], keyOf: (step: T) => string): { step: T; count: number }[] {
  const folded: { step: T; count: number; key: string }[] = []
  for (const step of steps) {
    const key = keyOf(step)
    const last = folded[folded.length - 1]
    if (last && last.key === key) last.count += 1
    else folded.push({ step, count: 1, key })
  }
  return folded.map(({ step, count }) => ({ step, count }))
}
