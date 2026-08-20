/**
 * What colour a thing is, when the thing is an app.
 *
 * Three surfaces draw the same pebble now — a mention in the composer, a link in
 * the transcript, a step in the landing reel — and they have to agree. A Gmail
 * pebble that is one red in the box you type in and a different red two lines
 * below it does not read as the same idea repeated; it reads as two unrelated
 * decorations, which is what colour is for the moment it stops being consistent.
 *
 * So the map lives here rather than beside any one of them, and the CSS that
 * mixes it lives in `pebble.css`. This module answers *which colour*, and only
 * that. How much of it survives against the current theme is the stylesheet's
 * answer, because that depends on the theme and this file cannot see it.
 */
import type { ToolKey } from './tools'

/**
 * Each app's own colour, at full strength.
 *
 * Taken from the real marks in `components/brand-icons.tsx` rather than
 * invented, so a Lark pebble is Lark's blue and a Zoho Books pebble is Zoho's.
 * Where a logo is genuinely several colours, this picks the one that identifies
 * it fastest *and* keeps it apart from its neighbours: Drive gets its yellow
 * rather than its green, because Sheets already owns green and two green pebbles
 * side by side say less than one green and one yellow.
 *
 * These are source values and never what reaches the screen — everything using
 * them mixes them down against the canvas first.
 *
 * Null for an app with no vendor colour. Those fall back to plain ink, which is
 * the same rule `tools.tsx` uses for Divo's own capabilities.
 */
const TINT: Partial<Record<NonNullable<ToolKey>, string>> = {
  gmail: '#EA4335',       // the red in the Gmail M
  sheets: '#0F9D58',      // Sheets green
  drive: '#FFBA00',       // Drive's yellow arm
  calendar: '#4285F4',    // Calendar blue
  docs: '#2684FC',        // Docs blue
  zohoBooks: '#226DB4',   // Zoho blue
  zohoCrm: '#E42527',     // Zoho red
  lark: '#4C6FFB',        // Lark blue
  airtable: '#18BFFF',    // Airtable cyan, not its red — Gmail has the red
  canva: '#7D2AE8',       // Canva purple
  semrush: '#FF642D',     // Semrush orange
  shopify: '#95BF47',     // Shopify green
}

/** The app's own colour, or null for one that has none. */
export function tintFor(key: ToolKey | null): string | null {
  if (!key) return null
  return TINT[key] ?? null
}

/**
 * A colour for a site nobody has a brand mark for.
 *
 * Identity, not measurement — nothing here encodes a quantity, so a hue picked
 * by name is honest. What it must be is *stable*: the same domain keeps the same
 * colour in every answer, or a page of citations becomes a lucky dip and the
 * colour stops carrying information at all.
 *
 * Saturation and lightness are fixed rather than hashed. Hashing them too would
 * produce the occasional near-grey and the occasional near-white, and a reader
 * cannot tell "this site has a dull colour" from "this pebble failed to load".
 */
export function tintForDomain(domain: string): string {
  let hash = 0
  for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `hsl(${hash} 62% 52%)`
}

/**
 * The colour for a link, whichever of the two it turns out to be.
 *
 * A known vendor wins over the domain hash, always. `docs.google.com` hashes to
 * some arbitrary hue, and if that were allowed to show, a Google Sheet in the
 * transcript would be a different colour from the Sheets mention in the
 * composer — the exact disagreement this module exists to prevent.
 */
export function tintForLink(key: ToolKey | null, domain: string): string {
  return tintFor(key) ?? tintForDomain(domain)
}
