import { resolveToolIdentity } from '@/lib/pi/tool-label'
import { isVendorCard } from './vendors'
import { isTerminalTool } from './terminal'

/**
 * The single question `renderToolInline` asks: does this tool call have a
 * bespoke card, or should it fall back to the generic JSON view?
 *
 * Kept as a pure predicate (rather than returning a component) so the wiring
 * stays a plain `if` in the container. New vendor families are added in
 * `vendors.ts`; this never changes.
 */
export function hasToolCard(part: Record<string, unknown>): boolean {
  return isVendorCard(resolveToolIdentity(part))
}

/** True when this part is a shell run that should render as a terminal. */
export function isTerminalToolPart(part: Record<string, unknown>): boolean {
  return isTerminalTool(resolveToolIdentity(part))
}
