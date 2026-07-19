/**
 * Human label for a tool-call part.
 *
 * Most Divo tool calls go through the `divo_gateway` dispatcher, whose real
 * operation lives inside the input JSON (`{ op, payload }`) rather than in the
 * tool name — so every call would otherwise read as the generic "Divo Gateway".
 * This surfaces the actual command instead: the `op` (e.g. `skills.search`,
 * `connections.list`), and for `tools.invoke` the concrete backend tool it
 * forwards to (`payload.toolId`, e.g. `zohoBooks`).
 *
 * Resolution is streaming-tolerant: the tool's input arrives token by token, so
 * a strict JSON.parse fails until the whole object has streamed. `op` is the
 * first key on the wire, so we scrape it (and `toolId`) out of the partial input
 * as soon as it appears — the name shows WHILE the call runs, not after it ends.
 */

type ToolLikePart = {
  type?: string
  /** AI SDK v6 dynamic/provider-executed tools carry the name here, not in `type`. */
  toolName?: string
  input?: unknown
}

/** The tool's own name, from `tool-<name>` static parts or `dynamic-tool` parts. */
function toolBaseName(part: ToolLikePart): string {
  const t = part.type ?? ''
  if (t.startsWith('tool-')) return t.slice('tool-'.length).trim()
  // 'dynamic-tool' (or anything else) → the name lives on `toolName`.
  return typeof part.toolName === 'string' ? part.toolName.trim() : ''
}

function str(rec: Record<string, unknown> | null, key: string): string | undefined {
  const v = rec?.[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/** First string value for `key` in a raw (possibly incomplete) JSON string. */
function scrape(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
  return m?.[1]?.trim() || undefined
}

/**
 * Pull `op` / `payload.toolId` out of a tool part's input, whether it's a
 * fully-parsed object, a complete JSON string, or a partial JSON string still
 * streaming in.
 */
function extractGatewayCall(input: unknown): { op?: string; toolId?: string } {
  // Object form (the SDK may hand back a partially-parsed object mid-stream).
  const obj = asObject(input)
  if (obj) {
    const op = str(obj, 'op')
    const toolId = str(asObject(obj['payload']), 'toolId')
    if (op || toolId) return { op, toolId }
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      const rec = asObject(parsed)
      return {
        op: str(rec, 'op'),
        toolId: str(asObject(rec?.['payload']), 'toolId'),
      }
    } catch {
      // Still streaming — scrape whatever keys have landed so far.
      return { op: scrape(input, 'op'), toolId: scrape(input, 'toolId') }
    }
  }

  return {}
}

/** camelCase → spaced words, so the header's capitalize reads them cleanly. */
function humanizeToolId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
}

/**
 * Display phrases for the gateway ops (`GATEWAY_OPS` in advance-backend).
 *
 * The rows read "Ran {label}" / "Running {label}", so these are noun phrases,
 * not the dotted identifiers — "Ran teach.learning.apply" is wire format
 * leaking into the UI. Anything unmapped falls back to `humanizeOp`, so a new
 * backend op degrades to readable words rather than dots.
 */
const OP_LABELS: Record<string, string> = {
  'capabilities.get': 'capability check',
  'tools.list': 'tool list',
  'tools.preflight': 'tool preflight',
  'tools.prepare': 'tool preparation',
  'tools.commit': 'tool commit',
  'tools.invoke': 'tool call',
  'skills.list': 'skill list',
  'skills.search': 'skill search',
  'skills.get': 'skill details',
  'persona.resolve': 'persona lookup',
  'teach.context.get': 'teach context',
  'teach.learning.apply': 'teach learning update',
  'google.plan': 'google plan',
  'connections.list': 'connection list',
  'media.image_ocr': 'image OCR',
}

/** Dotted/underscored op → spaced words, for ops with no explicit phrase. */
function humanizeOp(op: string): string {
  return op.replace(/[._-]+/g, ' ').trim()
}

/**
 * Everything known about a tool call: the display label plus the raw
 * identifiers behind it. Icon resolution needs the identifiers — by the time a
 * call has been humanised to "Zoho Books" the vendor is only recoverable by
 * parsing English back apart.
 */
export type ToolIdentity = {
  /** The tool's own name, e.g. `divo_gateway`, `divo_memory_recall`. */
  name: string
  /** Gateway op, e.g. `tools.invoke`, `skills.search`. */
  op?: string
  /** Concrete backend tool for `tools.invoke`, e.g. `zohoBooks`. */
  toolId?: string
  /** Humanised label for display. */
  label: string
}

export function resolveToolIdentity(part: ToolLikePart): ToolIdentity {
  const name = toolBaseName(part)
  const { op, toolId } = extractGatewayCall(part.input)

  // divo_gateway is a dispatcher — surface the op it's actually running, and
  // for tools.invoke the concrete tool it dispatches to. We check the input
  // whenever it looks like a gateway call (by name OR by shape), so the real
  // command still surfaces even before the tool name has landed.
  let label = name ? name.replaceAll('_', ' ') : ''
  if (name === 'divo_subagents') {
    label = 'subagents'
  }
  if (name === 'divo_gateway' || op || toolId) {
    if (op === 'tools.invoke' && toolId) label = humanizeToolId(toolId)
    else if (op) label = OP_LABELS[op] ?? humanizeOp(op)
    else if (toolId) label = humanizeToolId(toolId)
  }

  return { name, op, toolId, label }
}

export function resolveToolLabel(part: ToolLikePart): string {
  return resolveToolIdentity(part).label
}
