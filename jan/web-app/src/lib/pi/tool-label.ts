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

/**
 * Initialisms that must not be sentence-cased. The callers render through CSS
 * `capitalize` or `titleCase`, and both only ever raise a word's first letter —
 * so lowercasing the whole id turned `omsSiteData` into "Oms Site Data" and
 * `zohoCrm` into "Zoho Crm". Upper-casing them here survives both.
 */
const ACRONYMS = new Set(['oms', 'crm', 'rag', 'ocr'])

/** camelCase → spaced words, so the header's capitalize reads them cleanly. */
export function humanizeToolId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(' ')
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
  'work.resolve': 'work routing',
  'persona.resolve': 'persona lookup',
  'teach.context.get': 'teach context',
  'teach.learning.apply': 'teach learning update',
  'connections.list': 'connection list',
  // What the user did was attach an image; what Divo does is read it. "Image
  // OCR" is the implementation's name for that, and naming the technique
  // instead of the act made the log read like a stack trace.
  'media.image_ocr': 'read image',
  'automation.plan.create': 'prepare approval batch',
  'automation.plan.status': 'approval batch status',
}

/** Dotted/underscored op → spaced words, for ops with no explicit phrase. */
function humanizeOp(op: string): string {
  return op.replace(/[._-]+/g, ' ').trim()
}

/**
 * The argument worth showing next to a call, in priority order.
 *
 * "Ran web search" tells the user nothing they couldn't guess; the QUERY is the
 * information. Same for a file write (which file?) and a shell run (which
 * command?). These keys cover the desktop's built-ins (`read`/`write`/`edit`/
 * `bash`) and the common gateway payload shapes.
 *
 * Deliberately excludes anything that could carry a file's whole contents —
 * `content`, `new_str`, `body` — since those run to megabytes and would be
 * useless truncated to a row anyway.
 */
const DETAIL_KEYS = [
  'query',
  'q',
  'search',
  'searchQuery',
  'file_path',
  'filePath',
  'path',
  'file',
  'command',
  'cmd',
  'pattern',
  'url',
  // Local automation uses a human work title rather than an opaque command.
  'title',
  // Semrush's subject. Every one of its operations is "this research, about
  // THIS site", so without the domain the row is just "Ran semrush" — true and
  // useless. Last in priority: a call carrying both a query and a domain is a
  // search first.
  'domain',
]

/** Longest detail we'll put in a row before the CSS truncation takes over. */
const DETAIL_MAX = 120

/**
 * The value of `key` when it is the LAST thing on the wire and its closing
 * quote hasn't arrived yet — anchored to end-of-string so it can only ever
 * match the partial tail.
 *
 * `scrape` needs a closing quote, which is fine for `op` and `toolId` (more
 * keys always follow them) but wrong for exactly the argument we care about:
 * a search query or shell command is usually the last key, so it streams in
 * character by character and would otherwise stay invisible for the whole call.
 */
function scrapeUnterminated(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)$`))
  return m?.[1]?.trim() || undefined
}

function firstDetail(rec: Record<string, unknown> | null): string | undefined {
  if (!rec) return undefined
  for (const key of DETAIL_KEYS) {
    const value = str(rec, key)
    if (value) return value.slice(0, DETAIL_MAX)
  }
  return undefined
}

/**
 * The call's most informative argument, from wherever it lives: a gateway
 * payload, or the top-level args of a direct tool. Streaming-tolerant like the
 * rest of this module — a partial JSON string is scraped rather than parsed, so
 * the query shows WHILE the search runs, not after it returns.
 */
function extractDetail(input: unknown): string | undefined {
  // Where the arguments actually live, innermost first. A `tools.invoke`
  // dispatch nests them TWO deep — `{ op, payload: { toolId, args } }`, per
  // `toolsInvokePayloadSchema` in advance-backend — so `payload.args` is the
  // real home of a search query. `payload` and the top level cover direct
  // gateway ops and the desktop built-ins (`write`, `bash`, …) respectively.
  const argHosts = (rec: Record<string, unknown> | null) => {
    const payload = asObject(rec?.['payload'])
    return (
      firstDetail(asObject(payload?.['args'])) ??
      firstDetail(payload) ??
      firstDetail(rec)
    )
  }

  const obj = asObject(input)
  if (obj) return argHosts(obj)

  if (typeof input === 'string') {
    try {
      return argHosts(asObject(JSON.parse(input) as unknown))
    } catch {
      // Partial JSON: a flat key scan finds the value at any nesting depth,
      // so the streaming path needs no structure awareness.
      for (const key of DETAIL_KEYS) {
        const found = scrape(input, key) ?? scrapeUnterminated(input, key)
        if (found) return found.slice(0, DETAIL_MAX)
      }
      return undefined
    }
  }

  return undefined
}

/** `/a/b/c/report.html` → `report.html`. Rows are narrow; the tail is the part
 * that identifies the file. */
function basename(value: string): string {
  const tail = value.split(/[/\\]/).pop()
  return tail && tail.length ? tail : value
}

const PATH_KEY_TOOLS = /^(read|write|edit|multiedit|applypatch)$/

/**
 * Gateway ops whose headline argument is a local path rather than a query.
 *
 * These arrive as `divo_gateway`, so the tool-name check above can't see them,
 * and their `filePath` is the desktop's normalised attachment location — a long
 * absolute path that fills the row and identifies nothing. The basename is the
 * filename the user actually attached.
 */
const PATH_ARG_OPS = new Set(['media.image_ocr'])

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
  /**
   * The call's headline argument — search query, file name, shell command.
   * Shown dimmed beside the label; absent when the call has no single
   * argument worth naming.
   */
  detail?: string
  /**
   * The vendor-side operation a `tools.invoke` dispatch actually performs,
   * from `payload.args.nativeTool` / `payload.args.op` — e.g. `search_drive`,
   * `describe`.
   *
   * This is what makes a Google call describable as "Searching Google Drive"
   * rather than the useless "Ran 1 command": the toolId names WHO is being
   * called, and this names WHAT is being asked of them.
   */
  action?: string
}

/** The vendor-side verb inside a `tools.invoke` payload, if there is one. */
function extractAction(input: unknown): string | undefined {
  const fromArgs = (args: Record<string, unknown> | null) =>
    str(args, 'nativeTool') ?? str(args, 'action') ?? str(args, 'op')

  const obj = asObject(input)
  if (obj) return fromArgs(asObject(asObject(obj['payload'])?.['args']))

  if (typeof input === 'string') {
    try {
      const rec = asObject(JSON.parse(input) as unknown)
      return fromArgs(asObject(asObject(rec?.['payload'])?.['args']))
    } catch {
      // Partial JSON. Only `nativeTool` is safe to scrape flat — a bare "op"
      // key would match the OUTER gateway op (`tools.invoke`) and mislabel
      // every call as an invoke.
      return scrape(input, 'nativeTool')
    }
  }

  return undefined
}

/** `divo_todos` action from tool input (`create` / `update` / `list` / `clear`). */
export function extractTodoAction(
  input: unknown
): 'create' | 'update' | 'list' | 'clear' | undefined {
  const raw =
    str(asObject(input), 'action') ??
    (typeof input === 'string'
      ? scrape(input, 'action') ?? scrapeUnterminated(input, 'action')
      : undefined)
  if (
    raw === 'create' ||
    raw === 'update' ||
    raw === 'list' ||
    raw === 'clear'
  ) {
    return raw
  }
  return undefined
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
  if (name === 'divo_todos') {
    // The composer owns the rich task-plan view. Surface create vs update so
    // the work log does not read as a generic "command".
    const action = extractTodoAction(part.input)
    if (action === 'create') label = 'creating todos'
    else if (action === 'update') label = 'updating todos'
    else if (action === 'clear') label = 'clearing todos'
    else if (action === 'list') label = 'checking todos'
    else label = 'todos'
  }
  if (name === 'divo_artifact') {
    label = 'artifact'
  }
  if (name === 'divo_gateway' || op || toolId) {
    if (op === 'tools.invoke' && toolId) label = humanizeToolId(toolId)
    else if (op) label = OP_LABELS[op] ?? humanizeOp(op)
    else if (toolId) label = humanizeToolId(toolId)
  }

  // File tools show only the basename — a row is too narrow for a full path,
  // and the tail is what identifies the file.
  const raw = extractDetail(part.input)
  const action = extractAction(part.input)
  const detail =
    raw && (PATH_KEY_TOOLS.test(name) || (op && PATH_ARG_OPS.has(op)))
      ? basename(raw)
      : // With no better argument to show, the vendor verb is still more
        // informative than a bare vendor name.
        (raw ?? (action ? humanizeToolId(action) : undefined))

  return { name, op, toolId, label, detail, action }
}

export function resolveToolLabel(part: ToolLikePart): string {
  return resolveToolIdentity(part).label
}
