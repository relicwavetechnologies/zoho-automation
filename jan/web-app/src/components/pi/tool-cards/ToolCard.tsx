import { memo, useMemo } from 'react'
import { resolveToolIdentity } from '@/lib/pi/tool-label'
import { resolveToolCardModel } from '@/lib/pi/tool-cards/vendors'
import { normalizeToolOutput } from '@/lib/pi/tool-cards/output'
import { ToolCardShell, type ToolCardState } from './ToolCardShell'

type ToolPart = {
  type?: string
  toolName?: string
  state?: unknown
  input?: unknown
  output?: unknown
  error?: unknown
  errorText?: unknown
}

/** AI-SDK `ToolUIPart.state` → the card's three visible states. */
function cardState(state: unknown): ToolCardState {
  if (state === 'output-error' || state === 'output-denied') return 'error'
  if (state === 'output-available') return 'done'
  return 'running'
}

/** Pretty-print request params for the raw disclosure (object or JSON string). */
function prettyInput(input: unknown): string | undefined {
  if (input === null || input === undefined || input === '') return undefined
  let value: unknown = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return value as string
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorString(part: ToolPart): string | undefined {
  const e = part.errorText ?? part.error
  if (typeof e === 'string') return e
  if (e) {
    try {
      return JSON.stringify(e)
    } catch {
      return String(e)
    }
  }
  return undefined
}

/**
 * A branded card for any vendor tool call (Google, Lark, Zoho, web, Divo's own).
 *
 * The header and subject come from the *request* (which Divo controls, so they
 * are always reliable); the result — a headline, an openable link, a short
 * preview — is read out of the tool output by the vendor model's summarizer,
 * and the full request/result JSON stays available under "raw". A failed result
 * flips the card to its error state even before the SDK marks the part errored,
 * so an in-band failure still reads honestly.
 *
 * Renders null only when the call is not a carded vendor — the registry already
 * gates that, so in practice this always produces a card.
 */
export const ToolCard = memo(({ part }: { part: ToolPart }) => {
  const identity = useMemo(() => resolveToolIdentity(part), [part])
  const model = useMemo(
    () => resolveToolCardModel(identity, part.input),
    [identity, part.input]
  )
  const output = useMemo(() => normalizeToolOutput(part.output), [part.output])

  const summary = useMemo(
    () => (model ? model.buildSummary(output) : null),
    [model, output]
  )

  if (!model) return null

  const rawState = cardState(part.state)
  // A result that reports its own failure (envelope said "rejected") shows as an
  // error even if the SDK still marks the part available.
  const state: ToolCardState =
    rawState === 'done' && summary?.failed ? 'error' : rawState

  const action = state === 'running' ? model.verb.present : model.verb.past

  return (
    <ToolCardShell
      Mark={model.Mark}
      appName={model.appName}
      action={action}
      subject={model.subject}
      state={state}
      headline={state === 'done' ? summary?.headline : undefined}
      link={state === 'done' ? summary?.link : undefined}
      items={state === 'done' ? summary?.items : undefined}
      moreCount={state === 'done' ? summary?.moreCount : undefined}
      errorText={summary?.message ?? errorString(part)}
      rawInput={prettyInput(part.input)}
      rawOutput={output.raw || undefined}
    />
  )
})

ToolCard.displayName = 'ToolCard'
