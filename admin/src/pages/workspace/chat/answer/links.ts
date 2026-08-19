/**
 * Where an answer got its information.
 *
 * When Divo searches the web it writes ordinary markdown links, and a raw URL
 * in the middle of a sentence is the least readable thing on the page — a line
 * of punctuation the eye has to step over. A link is a *source*, so it is drawn
 * as one: the site's mark and its domain, in a chip the width of a word.
 *
 * The distinction that matters is whether the link text is doing any work. A
 * link the model wrote prose for ("last quarter's filing") keeps its prose and
 * stays underlined; a link whose text is the URL itself is saying nothing the
 * chip would not say better.
 */

export type Source = { href: string; domain: string }

/** The site a link points at, or null if it does not point at a site. */
export function domainOf(href: string): string | null {
  const match = /^https?:\/\/([^/?#\s]+)/i.exec(href.trim())
  if (!match) return null
  const host = match[1]!.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  return host.includes('.') ? host : null
}

/* ── What a link is ───────────────────────────────────────
   The question this module used to ask was "is the link's text bare?", and the
   mark was only reached on the yes branch. Since most links the model writes
   have real prose, most links arrived with no identity at all — an underline
   that said nothing about where it went.

   So bareness is no longer the question. It survives as one detail of one kind
   of link: whether a site's prose is worth keeping or is just the URL again. */

/**
 * The families a file is drawn as. Deliberately few — this picks a glyph, and a
 * reader distinguishing a spreadsheet from a document is the whole benefit. A
 * per-extension table would be a lot of entries buying nothing.
 */
export type FileFamily = 'doc' | 'sheet' | 'slide' | 'image' | 'archive' | 'code' | 'file'

const FAMILY_BY_EXTENSION: Record<string, FileFamily> = {
  pdf: 'doc', doc: 'doc', docx: 'doc', rtf: 'doc', odt: 'doc', txt: 'doc', md: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  ppt: 'slide', pptx: 'slide', key: 'slide', odp: 'slide',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', tiff: 'image', heic: 'image',
  zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
  json: 'code', yaml: 'code', yml: 'code', xml: 'code', html: 'code', ts: 'code',
  tsx: 'code', js: 'code', jsx: 'code', py: 'code', sh: 'code', sql: 'code',
}

export type LinkTarget =
  /** An address on the web. */
  | { kind: 'site'; domain: string }
  /** A path in the run's workspace, or anything else that names a file. */
  | { kind: 'file'; name: string; family: FileFamily }
  | { kind: 'mail'; address: string }
  /** An anchor, a scheme we do not draw, or something we cannot read. */
  | { kind: 'plain' }

const extensionOf = (value: string): string => {
  const name = value.split(/[?#]/)[0] ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The last segment of a path, whichever slash the writer used. */
export function fileNameOf(href: string): string {
  const cleaned = href.trim().replace(/^file:\/\//, '').replace(/\\/g, '/').split(/[?#]/)[0] ?? ''
  const segments = cleaned.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? cleaned
}

/**
 * What this href points at.
 *
 * File detection is ported from the desktop's `isFileMarkdownHref`, rule for
 * rule, because the two surfaces are shown the same answers by the same run and
 * a path that is a chip on one and dead text on the other is the divergence
 * this whole renderer exists to avoid.
 */
export function targetOf(href: string): LinkTarget {
  const value = href.trim()
  if (!value || value.startsWith('#')) return { kind: 'plain' }

  if (/^mailto:/i.test(value)) {
    const address = value.slice(7).split('?')[0] ?? ''
    return address ? { kind: 'mail', address } : { kind: 'plain' }
  }

  const domain = domainOf(value)
  if (domain) return { kind: 'site', domain }
  // Any other scheme — tel:, data:, a protocol we do not draw.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^file:/i.test(value)) return { kind: 'plain' }

  const extension = extensionOf(value)
  const looksLikePath =
    /^file:/i.test(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || (value.includes('/') && extension !== '')
    || extension !== ''
  if (!looksLikePath) return { kind: 'plain' }

  return {
    kind: 'file',
    name: fileNameOf(value),
    family: FAMILY_BY_EXTENSION[extension] ?? 'file',
  }
}

/**
 * Whether a browser can follow this href at all.
 *
 * A workspace path cannot be navigated to from a page — the file is in the
 * run's container, not on this origin — so the link offers the path instead of
 * a broken navigation.
 */
export function isNavigable(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href.trim())
}

/** A link whose text is just its own address, and so has nothing to lose. */
export function isBareLink(text: string, href: string): boolean {
  const value = text.trim().replace(/\/+$/, '')
  if (!value) return true
  if (value === href.trim().replace(/\/+$/, '')) return true
  if (/^https?:\/\//i.test(value)) return true
  return value.toLowerCase() === domainOf(href)
}

/** How many sites the strip under an answer will name before it stops. */
const MAX_SOURCES = 12

/**
 * Code, blanked out — so a URL inside it is not read as a citation.
 *
 * The strip is built by scanning the markdown, while the answer itself is drawn
 * from a parsed tree. Two readings of one string, and they disagreed in exactly
 * one place: a link inside a fenced block or a code span is text to the
 * renderer and was a citation to the scanner. An answer showing a reader a
 * `curl https://api.stripe.com/v1/charges` grew a Stripe chip claiming the
 * answer had consulted Stripe. It had not; it had printed a command.
 *
 * Replaced with spaces rather than removed, so every offset in the string is
 * still where it was and nothing either side of a block can fuse into a token
 * that was never written.
 */
function withoutCode(markdown: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ')
  return markdown
    // Fenced first: a fence may contain unbalanced backticks that would
    // otherwise be read as spans and swallow half the answer with them.
    .replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm, blank)
    // An unclosed fence runs to the end of the answer, which is what a
    // half-streamed code block is for most of its life.
    .replace(/^[ \t]*(?:`{3,}|~{3,})[\s\S]*$/m, blank)
    .replace(/(`+)(?:[^`]|(?!\1)`)*\1/g, blank)
}

/**
 * Every site an answer drew on, once each, in the order they were cited.
 *
 * Read off the markdown rather than the rendered tree, because the strip sits
 * outside the answer and is built before any of it is drawn. One entry per
 * domain: an answer citing six pages of the same filing has one source, and a
 * strip that said "6 sources" would be flattering itself.
 *
 * It does not get to disagree with the renderer about what counts as prose —
 * see `withoutCode`.
 */
export function sourcesIn(markdown: string): Source[] {
  const found = new Map<string, Source>()
  const prose = withoutCode(markdown)

  const remember = (href: string) => {
    const domain = domainOf(href)
    if (!domain || found.has(domain)) return
    found.set(domain, { href: href.trim(), domain })
  }

  for (const [, href] of prose.matchAll(/\[[^\]]*\]\(\s*(<?[^)\s]+)>?\s*(?:"[^"]*")?\)/g)) {
    remember(href!.replace(/^</, ''))
  }
  for (const [href] of prose.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    remember(href)
  }

  return [...found.values()].slice(0, MAX_SOURCES)
}

/**
 * A stable tint for a site with no mark of its own.
 *
 * Identity, not measurement — nothing here encodes a quantity, so a hue chosen
 * by name is honest. It has to be stable, though: the same site keeps the same
 * colour in every answer, or the strip becomes a lucky dip.
 */
export function tintOf(domain: string): number {
  let hash = 0
  for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

/** The letter on the tile. */
export function initialOf(domain: string): string {
  return (domain.replace(/^(www|m|en)\./, '')[0] ?? '?').toUpperCase()
}
