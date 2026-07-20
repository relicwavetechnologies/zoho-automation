import { resolveToolIdentity, type ToolIdentity } from './tool-label'
import type { DivoSubagentEvent } from './subagent'

/**
 * What a child's event line actually is.
 *
 * Pi reports a subagent's steps as a flat list of `{seq, kind, label}`, and for
 * a tool step the label is the raw wire call:
 *
 *   divo_gateway {"op":"tools.invoke","payload":{"toolId":"googleGmail", …}}
 *
 * Printed as-is that is a JSON blob wrapping onto two lines in a 13px row —
 * the least readable thing on the screen, in the one place a user opens
 * specifically to find out what an agent did. The parent work log already
 * knows how to say this ("Google Gmail · search gmail messages", with the
 * Gmail mark); the child list just never routed through it.
 *
 * So each event resolves to one of two shapes: a tool call the log can render
 * with its normal vocabulary, or a plain note ("Queued", "Thinking").
 */
export type SubagentEventView =
  | { kind: 'tool'; identity: ToolIdentity; part: Record<string, unknown> }
  | { kind: 'note'; text: string }

/**
 * Splits `divo_gateway {…}` into its tool name and JSON argument.
 *
 * Matches on the FIRST `{` rather than parsing the whole label, because the
 * argument is frequently truncated mid-object by the event budget upstream —
 * a strict parse would throw away every long call, which are exactly the
 * interesting ones. A failed parse still yields the tool name.
 */
function splitToolLabel(label: string): { name: string; input?: unknown } | undefined {
  const brace = label.indexOf('{')
  const name = (brace === -1 ? label : label.slice(0, brace)).trim()
  if (!name || /\s/.test(name)) return undefined

  if (brace === -1) return { name }

  const raw = label.slice(brace)
  try {
    return { name, input: JSON.parse(raw) }
  } catch {
    // Truncated tail. Hand the raw string over anyway — `resolveToolIdentity`
    // scrapes partial JSON on purpose, since that is also what a streaming
    // call looks like before its closing brace arrives.
    return { name, input: raw }
  }
}

/** Event kinds Pi uses for a tool step, as opposed to a lifecycle note. */
const TOOL_EVENT_KINDS = new Set(['tool', 'tool_call', 'tool_result', 'toolcall'])

/**
 * A child's task brief, flattened to one readable line.
 *
 * The brief is a markdown document — it opens `## Task: …` and runs to several
 * paragraphs. The card shows it truncated on a single line, where the syntax
 * survives but none of the structure does, so the row began with a literal
 * "##" and ran the heading straight into the first sentence with no break.
 *
 * This strips the marks rather than rendering them: at one truncated line
 * there is no structure left to render, only noise to remove.
 */
export function summarizeSubagentTask(task: string): string {
  return task
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function describeSubagentEvent(event: DivoSubagentEvent): SubagentEventView {
  const label = (event.label ?? '').trim()
  const fallback = label || event.kind.replaceAll('_', ' ')

  // Trust the label's shape over the event kind: the kind vocabulary has
  // drifted before, but a label carrying a tool name is unambiguous.
  const split = label ? splitToolLabel(label) : undefined
  const looksLikeTool = split && (TOOL_EVENT_KINDS.has(event.kind) || label.includes('{') || split.name.includes('_'))

  if (split && looksLikeTool) {
    const part = { type: `tool-${split.name}`, input: split.input }
    const identity = resolveToolIdentity(part)
    // A resolver that learned nothing beyond the raw name is not an
    // improvement on printing the name, but it is not worse either — what
    // matters is that we never show the JSON.
    if (identity.label) return { kind: 'tool', identity, part }
  }

  return { kind: 'note', text: fallback }
}
