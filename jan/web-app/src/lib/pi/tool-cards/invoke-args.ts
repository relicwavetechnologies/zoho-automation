/**
 * Pulling the *real* arguments out of a `divo_gateway` tool-call part.
 *
 * A vendor call reaches the desktop as a `tools.invoke` dispatch whose input is
 * `{ op: 'tools.invoke', payload: { toolId, args } }`, per `toolsInvokePayloadSchema`
 * in advance-backend. The `args` object is where both the vendor verb
 * (`nativeTool`) and the actual call parameters (a Gmail query, a spreadsheet id)
 * live, side by side.
 *
 * The tool-card summaries are driven off these args because they are the one
 * thing Divo fully controls: whatever the external MCP returns, the *request* is
 * always well-shaped and always present. `tool-label.ts` scrapes the same input
 * for a single headline string; this returns the whole args object so a card can
 * read several fields at once.
 *
 * Streaming-tolerant like the rest of the trace: the input arrives token by
 * token, so a strict parse fails until the object has fully landed. When it is
 * still partial we return whatever object has parsed so far, or null — a card in
 * its skeleton state needs no args yet.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The `payload.args` object of a gateway `tools.invoke` dispatch, or null.
 *
 * Accepts the input as a parsed object (the SDK may hand back a partially
 * parsed object mid-stream) or a JSON string. A partial/invalid string yields
 * null rather than throwing — the card falls back to its running state.
 */
export function extractInvokeArgs(input: unknown): Record<string, unknown> | null {
  const fromObject = (obj: Record<string, unknown> | null) => {
    const payload = asRecord(obj?.['payload'])
    // A direct gateway op (no `tools.invoke` wrapper) keeps its params at the
    // payload root; an invoke nests them one level deeper under `args`.
    return asRecord(payload?.['args']) ?? payload
  }

  const obj = asRecord(input)
  if (obj) return fromObject(obj)

  if (typeof input === 'string') {
    try {
      return fromObject(asRecord(JSON.parse(input) as unknown))
    } catch {
      return null
    }
  }

  return null
}

/** A string field from an args object, trimmed, or undefined when absent/empty. */
export function argString(
  args: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

/** A numeric field from an args object, or undefined. */
export function argNumber(
  args: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  if (!args) return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

/** The length of an array field (e.g. how many rows an append was handed), or undefined. */
export function argArrayLength(
  args: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  if (!args) return undefined
  for (const key of keys) {
    const value = args[key]
    if (Array.isArray(value)) return value.length
  }
  return undefined
}
