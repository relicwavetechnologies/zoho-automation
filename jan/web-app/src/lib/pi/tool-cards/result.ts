/**
 * Turning a raw tool result into a plain-English brief with the actual data.
 *
 * A gateway result reaches the desktop double-wrapped: the local gateway client
 * prefixes a human line and JSON-stringifies the tool payload
 * (`"Request succeeded.\n\n" + JSON(data)`, see `divo-gateway/gateway-client.ts`),
 * and the tool payload is itself often a nested MCP envelope
 * (`{ content: [{ type: 'text', text }] }`) whose text may be more JSON. Shapes
 * vary per vendor and per operation, and we have no schema for the external MCP
 * output.
 *
 * So rather than parse one known shape, this walks whatever landed and pulls out
 * what a reader wants: how many things came back, a title/name, an openable
 * link, and — the point of the card — the ITEMS themselves (the tasks, records,
 * rows), each rendered to one readable line. Everything is depth- and
 * size-capped and never throws.
 */

import type { NormalizedOutput } from './output'
import { detectCount } from './output'

export type ToolResultSummary = {
  /** The one-line takeaway, e.g. "5 messages", "Created “Q3 Budget”". */
  headline?: string
  /** A primary openable link (a created doc, a shared file). */
  link?: string
  /** The actual result rows, each rendered to one line (task titles, cells). */
  items?: string[]
  /** How many items exist beyond the ones in `items`. */
  moreCount?: number
  /** True when the result reports a failure the header should reflect. */
  failed?: boolean
  /** A human message from the envelope (error text, plan note). */
  message?: string
}

/** Envelope prefixes the local gateway client emits ahead of the payload. */
type Envelope = { status: 'ok' | 'error'; body: string; message?: string }

function stripEnvelope(text: string): Envelope {
  const t = text.trimStart()
  const succeeded = t.match(/^Request succeeded\.\s*/)
  if (succeeded) return { status: 'ok', body: t.slice(succeeded[0].length) }

  const rejected = t.match(/^Request (?:rejected|unauthorized|failed)[^\n]*\.?\s*/i)
  if (rejected) {
    const rest = t.slice(rejected[0].length).trim()
    return { status: 'error', body: '', message: firstLine(rest) }
  }
  return { status: 'ok', body: t }
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  return line ? line.slice(0, 240) : undefined
}

/** Best-effort JSON parse of an envelope body; null when it's plain prose. */
function parseBody(body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

const MAX_DEPTH = 6
const MAX_NODES = 3000
/**
 * How many items we hand to the card at most. The card shows a handful and
 * expands the rest inline on click, so this is the ceiling on what a click can
 * reveal before the truly-huge remainder is left to the raw view.
 */
const ITEM_LIMIT = 50
const URL_KEY = /url|link|href/i
const TITLE_KEY = /^(title|name|subject|display_?name|file_?name|summary)$/i
const COUNT_KEY = /^(count|total|total_?count|num_?results|result_?count)$/i
const COLLECTION_KEY =
  /^(messages|files|items|results|rows|values|events|records|threads|documents|docs|contacts|tasks|entries|data|comments|labels|folders|matches|list|children)$/i
/** Fields to label an item object with, in priority order. */
const ITEM_LABEL_KEYS = [
  'summary', 'title', 'name', 'subject', 'display_name', 'displayName',
  'file_name', 'fileName', 'text', 'label', 'heading', 'question',
  'email', 'snippet', 'description', 'value',
]

type Walker = {
  texts: string[]
  link?: string
  title?: string
  count?: number
  bestArray?: unknown[]
  bestScore: number
  budget: number
}

/** How item-like an array is, so the richest collection wins as the preview. */
function arrayScore(arr: unknown[], keyMatch: boolean): number {
  if (arr.length === 0) return 0
  const first = arr[0]
  let base = 0
  if (first && typeof first === 'object') base = 2
  else if (typeof first === 'string' || typeof first === 'number') base = 1
  return base + (keyMatch ? 2 : 0)
}

function consider(w: Walker, arr: unknown[], keyMatch: boolean): void {
  const score = arrayScore(arr, keyMatch)
  if (score > w.bestScore) {
    w.bestScore = score
    w.bestArray = arr
  }
}

/** One depth-first pass collecting every signal we know how to use. */
function walk(node: unknown, depth: number, w: Walker): void {
  if (w.budget <= 0 || depth > MAX_DEPTH) return
  w.budget--

  if (typeof node === 'string') {
    const s = node.trim()
    if (s) w.texts.push(s.slice(0, 800))
    return
  }
  if (Array.isArray(node)) {
    if (depth <= 1) consider(w, node, false) // a top-level array is the result
    for (const item of node.slice(0, 50)) walk(item, depth + 1, w)
    return
  }
  if (!node || typeof node !== 'object') return

  const obj = node as Record<string, unknown>
  if (obj.type === 'text' && typeof obj.text === 'string') {
    const s = obj.text.trim()
    if (s) w.texts.push(s.slice(0, 1200))
    return
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      const s = value.trim()
      if (!s) continue
      if (w.link === undefined && URL_KEY.test(key) && /^https?:\/\//.test(s)) w.link = s
      else if (w.title === undefined && TITLE_KEY.test(key)) w.title = s.slice(0, 160)
    } else if (typeof value === 'number') {
      if (w.count === undefined && COUNT_KEY.test(key)) w.count = value
    } else if (Array.isArray(value)) {
      const keyMatch = COLLECTION_KEY.test(key)
      if (keyMatch && w.count === undefined) w.count = value.length
      consider(w, value, keyMatch)
      walk(value, depth + 1, w)
    } else if (value && typeof value === 'object') {
      walk(value, depth + 1, w)
    }
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

/** A single result item rendered to one readable line. */
function renderItem(el: unknown): string | undefined {
  if (el === null || el === undefined) return undefined
  if (typeof el === 'string') return el.trim().slice(0, 140) || undefined
  if (typeof el === 'number' || typeof el === 'boolean') return String(el)
  if (Array.isArray(el)) {
    // A spreadsheet row — join its cells.
    const cells = el
      .filter((c) => c !== null && c !== undefined && typeof c !== 'object')
      .map((c) => String(c))
    return cells.length ? cells.join(' · ').slice(0, 140) : undefined
  }
  if (typeof el === 'object') {
    const obj = el as Record<string, unknown>
    const label = firstString(obj, ITEM_LABEL_KEYS)
    if (label) return label.slice(0, 140)
    // No known label — show the first couple of scalar fields.
    const scalars = Object.entries(obj)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${v}`)
    return scalars.length ? scalars.join(' · ').slice(0, 140) : undefined
  }
  return undefined
}

/** Render up to ITEM_LIMIT lines from an array, plus how many were left out. */
function renderItems(arr: unknown[]): { items: string[]; moreCount: number } {
  const items: string[] = []
  for (const el of arr) {
    const line = renderItem(el)
    if (line) items.push(line)
    if (items.length >= ITEM_LIMIT) break
  }
  const moreCount = Math.max(0, arr.length - items.length)
  return { items, moreCount }
}

const PREVIEW_SKIP =
  /^(request (succeeded|failed)|found|returned|showing|here are|listing|total|results?:)\b/i

/** Fallback items from a text body (numbered/bulleted lists), when no array. */
function previewLines(texts: string[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const block of texts) {
    for (const raw of block.split('\n')) {
      const line = raw.trim().replace(/^[-*•\d.)\s]+/, '').trim()
      if (line.length >= 2 && !PREVIEW_SKIP.test(line) && !seen.has(line)) {
        seen.add(line)
        lines.push(line.slice(0, 140))
      }
      if (lines.length >= ITEM_LIMIT) return lines
    }
  }
  return lines
}

export type SummarizeHints = {
  /** Noun for a count, e.g. "message" → "5 messages". Defaults to "result". */
  countNoun?: string
  /** The action group, so a write can headline its target rather than a count. */
  action?: 'read' | 'search' | 'create' | 'update' | 'send' | 'delete' | 'other'
  /** The call's request subject, used as a fallback headline for writes. */
  subject?: string
}

function plural(n: number, noun: string): string {
  if (n === 1) return `1 ${noun}`
  const many = /s$|sh$|ch$|x$|z$/.test(noun) ? `${noun}es` : `${noun}s`
  return `${n} ${many}`
}

/**
 * Extract renderable items from any value (used for a write's request, to show
 * what was written when the response echoes nothing). Finds the richest array
 * anywhere inside and renders it.
 */
export function itemsFromValue(value: unknown): { items: string[]; moreCount: number } {
  if (value === null || value === undefined) return { items: [], moreCount: 0 }
  const w: Walker = { texts: [], bestScore: 0, budget: MAX_NODES }
  walk(value, 0, w)
  return w.bestArray ? renderItems(w.bestArray) : { items: [], moreCount: 0 }
}

/**
 * Build the reader-facing summary from a normalized output plus light hints.
 * Pure and defensive — any missing signal is simply omitted.
 */
export function summarizeToolResult(
  output: NormalizedOutput,
  hints: SummarizeHints = {}
): ToolResultSummary {
  if (output.empty) return {}

  const w: Walker = { texts: [], bestScore: 0, budget: MAX_NODES }
  if (output.text) {
    const env = stripEnvelope(output.text)
    if (env.status === 'error') return { failed: true, message: env.message }
    const parsed = parseBody(env.body)
    if (parsed !== null) walk(parsed, 0, w)
    else if (env.body.trim()) w.texts.push(env.body.trim().slice(0, 1200))
  } else if (output.value && typeof output.value === 'object') {
    walk(output.value, 0, w)
  }

  const count = w.count ?? w.bestArray?.length ?? detectCount(w.texts.join('\n'))
  const noun = hints.countNoun ?? 'result'

  const rendered = w.bestArray ? renderItems(w.bestArray) : { items: previewLines(w.texts), moreCount: 0 }

  const isWrite =
    hints.action === 'create' ||
    hints.action === 'update' ||
    hints.action === 'send' ||
    hints.action === 'delete'

  let headline: string | undefined
  if (isWrite) {
    // A write's takeaway is WHAT it touched; the subject already shows on the
    // action line, so only add a title the result surfaced.
    headline = w.title ? `“${w.title}”` : undefined
  } else if (count !== undefined) {
    headline = plural(count, noun)
  } else if (w.title) {
    headline = w.title
  }

  const summary: ToolResultSummary = {}
  if (headline) summary.headline = headline
  if (w.link) summary.link = w.link
  if (rendered.items.length) {
    summary.items = rendered.items
    if (rendered.moreCount > 0) summary.moreCount = rendered.moreCount
  }
  return summary
}
